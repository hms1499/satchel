"use client";

import { TransactionBuilder, placeholderP2PKHUnlocker, type SpendableUtxo } from "cashscript";
import { binToHex, publicKeyToP2pkhCashAddress } from "@bitauth/libauth";
import type { DappConnectionManager } from "@wizardconnect/dapp";
import { NETWORK } from "../config";
import { buildGenesis, buildWithdraw, findVaultUtxo, getVaultContract, lockingBytecodeOf, type VaultParams } from "../vault";
import { paramsToDescriptorParams, type VaultDescriptor } from "../descriptor";
import { encodeRecoveryMemo, findVaultsInTransactions } from "../recovery";
import { broadcast, getBlockHeight, getHistory, getTransactions, getUtxosFor, httpProvider } from "./chain";

const PREFIX = NETWORK === "mainnet" ? "bitcoincash" : "bchtest";
const PATHS = [
  { name: "receive", child: 0 },
  { name: "change", child: 1 },
] as const;
const SCAN_DEPTH = 10;

export interface WalletAccount {
  pathName: "receive" | "change";
  index: number;
  pubHex: string;
  address: string;
}

function account(manager: DappConnectionManager, path: (typeof PATHS)[number], index: number): WalletAccount | null {
  const pub = manager.getPubkey(path.child, BigInt(index));
  if (!pub) return null;
  const { address } = publicKeyToP2pkhCashAddress({ publicKey: pub, prefix: PREFIX });
  return { pathName: path.name, index, pubHex: binToHex(pub), address };
}

/** The vault owner key is the wallet's first receive key (receive/0). */
export function ownerAccount(manager: DappConnectionManager): WalletAccount {
  const owner = account(manager, PATHS[0], 0);
  if (!owner) throw new Error("Wallet did not share its receive key yet. Reconnect the wallet.");
  return owner;
}

export function walletAccounts(manager: DappConnectionManager): WalletAccount[] {
  const out: WalletAccount[] = [];
  for (const path of PATHS) for (let i = 0; i < SCAN_DEPTH; i++) {
    const a = account(manager, path, i);
    if (a) out.push(a);
  }
  return out;
}

export interface FundingUtxo {
  utxo: SpendableUtxo;
  account: WalletAccount;
}

export async function walletFunds(manager: DappConnectionManager): Promise<FundingUtxo[]> {
  const accounts = walletAccounts(manager);
  const byAddress = await getUtxosFor(accounts.map((a) => a.address));
  return accounts.flatMap((account) => (byAddress[account.address] ?? []).filter((u) => !u.token).map((utxo) => ({ utxo, account })));
}

export const sumSats = (list: FundingUtxo[]) => list.reduce((s, f) => s + f.utxo.satoshis, 0n);

/** Asks the wallet to sign (it never broadcasts), then broadcasts through our proxy. */
async function signAndBroadcast(
  manager: DappConnectionManager,
  builder: TransactionBuilder,
  inputPaths: [number, string, number][],
  userPrompt: string,
): Promise<string> {
  const transaction = builder.generateWcTransactionObject({ broadcast: false, userPrompt });
  const response = await manager.signTransaction({ transaction: transaction as never, inputPaths });
  if (response.error) throw new Error(`Wallet: ${response.error}`);
  if (!response.signedTransaction) throw new Error("The wallet did not return a signed transaction");
  return broadcast(response.signedTransaction);
}

/** Sends all wallet coins to receive/0 so that we get an outpoint with index 0 (needed to mint the state NFT). */
async function consolidate(manager: DappConnectionManager, funds: FundingUtxo[], owner: WalletAccount): Promise<FundingUtxo> {
  const build = (fee: bigint) => {
    const b = new TransactionBuilder({ provider: httpProvider });
    for (const f of funds) b.addInput(f.utxo, placeholderP2PKHUnlocker(f.account.address));
    b.addOutput({ to: owner.address, amount: sumSats(funds) - fee });
    return b;
  };
  const fee = build(500n).getTransactionSize() + 2n;
  const builder = build(fee);
  const txid = await signAndBroadcast(
    manager,
    builder,
    funds.map((f, i) => [i, f.account.pathName, f.account.index]),
    "Satchel: prepare your coins (step 1 of 2)",
  );
  return {
    account: owner,
    utxo: { txid, vout: 0, satoshis: sumSats(funds) - fee, lockingBytecode: binToHex(lockingBytecodeOf(owner.address)) },
  };
}

export interface CreateVaultInput {
  deposit: bigint;
  capPerPeriod: bigint;
  periodBlocks: bigint;
  allowlist: string[];
}

/**
 * `knownPayees` is the server's payee catalog (tool payTo addresses, in catalog order). The genesis tx
 * stores the allowlist as indexes into it, so the vault can be recovered from chain (see recovery.ts).
 */
export async function createVault(
  manager: DappConnectionManager,
  input: CreateVaultInput,
  knownPayees: string[],
  onStep: (text: string) => void,
): Promise<VaultDescriptor> {
  onStep("Registering a fresh agent key…");
  const reg = await fetch("/api/agent/register", { method: "POST" });
  if (!reg.ok) throw new Error("Could not register an agent");
  const agent = (await reg.json()) as { agentIndex: number; agentPk: string; token: string };

  const owner = ownerAccount(manager);
  const params: VaultParams = { ownerPk: owner.pubHex, agentPk: agent.agentPk, ...input };
  const contract = getVaultContract(params, httpProvider);

  onStep("Looking for coins in your wallet…");
  let funds = await walletFunds(manager);
  const needed = input.deposit + 3_000n;
  if (sumSats(funds) < needed) {
    throw new Error(`Not enough BCH in the connected wallet: need about ${needed.toLocaleString()} sats, found ${sumSats(funds).toLocaleString()}.`);
  }

  let genesisInput = funds.find((f) => f.utxo.vout === 0);
  if (!genesisInput) {
    onStep("Approve the preparation transaction in your wallet…");
    genesisInput = await consolidate(manager, funds, owner);
    funds = [genesisInput];
  }
  // Use the vout-0 coin first, then add others until the deposit is covered.
  const ordered = [genesisInput, ...funds.filter((f) => f !== genesisInput).sort((a, b) => Number(b.utxo.satoshis - a.utxo.satoshis))];
  const chosen: FundingUtxo[] = [];
  for (const f of ordered) {
    chosen.push(f);
    if (sumSats(chosen) >= needed) break;
  }

  const startHeight = await getBlockHeight();
  const change = account(manager, PATHS[1], 0) ?? owner;
  const { builder } = buildGenesis({
    contract,
    inputs: chosen.map((f) => ({ utxo: f.utxo, unlocker: placeholderP2PKHUnlocker(f.account.address) })),
    deposit: input.deposit,
    startHeight,
    changeAddress: change.address,
    opReturn: encodeRecoveryMemo(params, agent.agentIndex, knownPayees),
  });

  onStep("Approve the vault creation in your wallet…");
  const txid = await signAndBroadcast(
    manager,
    builder,
    chosen.map((f, i) => [i, f.account.pathName, f.account.index]),
    `Satchel: create an agent vault with ${input.deposit.toLocaleString()} sats`,
  );

  return {
    version: 1,
    network: NETWORK,
    agentIndex: agent.agentIndex,
    token: agent.token,
    params: paramsToDescriptorParams(params),
    createdAt: Date.now(),
    genesisTxid: txid,
  };
}

/** Owner withdraws everything back to receive/0. The wallet fills in the owner signature (placeholder). */
export async function withdrawVault(manager: DappConnectionManager, params: VaultParams): Promise<{ txid: string; amount: bigint }> {
  const owner = ownerAccount(manager);
  if (owner.pubHex !== params.ownerPk) throw new Error("This wallet is not the owner of the vault");
  const contract = getVaultContract(params, httpProvider);
  const vaultUtxo = await findVaultUtxo(contract);
  if (!vaultUtxo) throw new Error("Vault not found (already withdrawn?)");
  const builder = buildWithdraw({ contract, vaultUtxo, to: owner.address });
  const amount = builder.outputs[0].amount;
  const txid = await signAndBroadcast(manager, builder, [[0, "receive", 0]], `Satchel: withdraw ${amount.toLocaleString()} sats to your wallet`);
  return { txid, amount };
}

/**
 * Finds vaults this wallet owns that are still open, using only the blockchain: the genesis memo of
 * every recent transaction of the wallet's addresses. Used when the browser lost the vault descriptor.
 */
export async function findOwnedVaults(manager: DappConnectionManager, knownPayees: string[]): Promise<{ descriptor: VaultDescriptor; balance: bigint }[]> {
  const owner = ownerAccount(manager);
  const txids = await getHistory(walletAccounts(manager).map((a) => a.address));
  const txs = await getTransactions(txids.slice(0, 60));
  const found = findVaultsInTransactions(txs, owner.pubHex, knownPayees, httpProvider);
  const open: { descriptor: VaultDescriptor; balance: bigint }[] = [];
  for (const v of found) {
    const utxo = await findVaultUtxo(getVaultContract(v.params, httpProvider));
    if (!utxo) continue; // already withdrawn
    open.push({
      balance: utxo.satoshis,
      descriptor: {
        version: 1,
        network: NETWORK,
        agentIndex: v.agentIndex,
        token: "",
        params: paramsToDescriptorParams(v.params),
        genesisTxid: v.genesisTxid,
        recovered: true,
      },
    });
  }
  return open;
}
