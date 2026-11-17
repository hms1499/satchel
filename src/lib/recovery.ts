import { binToHex, decodeTransaction, flattenBinArray, hexToBin, utf8ToBin } from "@bitauth/libauth";
import type { NetworkProvider } from "cashscript";
import { getVaultContract, lockingBytecodeOf, type VaultParams } from "./vault";

/**
 * On-chain vault recovery.
 *
 * The owner can only withdraw if they can rebuild the contract, which needs the agent key and the
 * vault settings. Those used to live only in the browser (localStorage). The genesis transaction now
 * also carries them in an OP_RETURN output:
 *
 *   OP_RETURN "STCH" <version 1 | agentIndex u32 LE | agentPk 33B | cap u64 LE | periodBlocks u32 LE | n | n payee indexes>
 *
 * Payees are stored as indexes into the server's known payee list (the paid-tool catalog).
 * The memo is not trusted: a vault is only recovered when the contract rebuilt from it has exactly the
 * locking bytecode of the genesis output 0. The agent access token is deliberately NOT on-chain
 * (anyone could read it and burn the budget), so a recovered vault can be inspected and withdrawn,
 * but driving the agent again needs a new vault.
 */
export const RECOVERY_PREFIX = "STCH";
const VERSION = 1;
const PREFIX_BIN = utf8ToBin(RECOVERY_PREFIX);
const MAX_PAYEES = 8;

function le(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`value ${value} does not fit in ${bytes} bytes`);
  return out;
}

function readLe(bin: Uint8Array): bigint {
  let v = 0n;
  for (let i = bin.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bin[i]);
  return v;
}

/** OP_RETURN chunks for `TransactionBuilder.addOpReturnOutput` (strings starting with 0x are hex). */
export function encodeRecoveryMemo(params: VaultParams, agentIndex: number, knownPayees: string[]): string[] {
  const indexes = params.allowlist.map((a) => {
    const i = knownPayees.indexOf(a);
    if (i < 0) throw new Error(`${a} is not a known payee; the vault could not be recovered from chain`);
    return i;
  });
  if (indexes.length === 0 || indexes.length > MAX_PAYEES) throw new Error("Allowlist must have 1 to 8 entries");
  const payload = flattenBinArray([
    Uint8Array.of(VERSION),
    le(BigInt(agentIndex), 4),
    hexToBin(params.agentPk),
    le(params.capPerPeriod, 8),
    le(params.periodBlocks, 4),
    Uint8Array.of(indexes.length, ...indexes),
  ]);
  return [RECOVERY_PREFIX, `0x${binToHex(payload)}`];
}

/** Parses a recovery OP_RETURN. Returns null for anything that is not a well-formed v1 memo. */
export function decodeRecoveryMemo(
  lockingBytecode: Uint8Array,
  ownerPk: string,
  knownPayees: string[],
): { agentIndex: number; params: VaultParams } | null {
  const b = lockingBytecode;
  // 0x6a, push(4) "STCH", push(len) payload — both pushes are direct (len <= 75).
  if (b.length < 7 || b[0] !== 0x6a || b[1] !== PREFIX_BIN.length) return null;
  if (binToHex(b.slice(2, 6)) !== binToHex(PREFIX_BIN)) return null;
  const len = b[6];
  if (len > 75 || b.length !== 7 + len) return null;
  const p = b.slice(7);
  const fixed = 1 + 4 + 33 + 8 + 4 + 1;
  if (p.length < fixed || p[0] !== VERSION) return null;
  const count = p[fixed - 1];
  if (count === 0 || count > MAX_PAYEES || p.length !== fixed + count) return null;
  const agentPk = binToHex(p.slice(5, 38));
  if (!/^0[23]/.test(agentPk)) return null;
  const allowlist: string[] = [];
  for (const i of p.slice(fixed)) {
    if (i >= knownPayees.length) return null;
    allowlist.push(knownPayees[i]);
  }
  return {
    agentIndex: Number(readLe(p.slice(1, 5))),
    params: {
      ownerPk,
      agentPk,
      capPerPeriod: readLe(p.slice(38, 46)),
      periodBlocks: readLe(p.slice(46, 50)),
      allowlist,
    },
  };
}

export interface RecoveredVault {
  agentIndex: number;
  params: VaultParams;
  genesisTxid: string;
}

/**
 * Finds Satchel genesis transactions of `ownerPk` among raw transactions, and keeps only those whose
 * memo rebuilds exactly the contract that output 0 pays to.
 */
export function findVaultsInTransactions(
  txs: { txid: string; hex: string }[],
  ownerPk: string,
  knownPayees: string[],
  provider: NetworkProvider,
): RecoveredVault[] {
  const found: RecoveredVault[] = [];
  for (const { txid, hex } of txs) {
    let tx;
    try {
      tx = decodeTransaction(hexToBin(hex));
    } catch {
      continue;
    }
    if (typeof tx === "string" || tx.outputs.length < 2) continue;
    const vaultOutput = tx.outputs[0];
    if (vaultOutput.token?.nft?.capability !== "mutable") continue;
    for (const output of tx.outputs.slice(1)) {
      const memo = decodeRecoveryMemo(output.lockingBytecode, ownerPk, knownPayees);
      if (!memo) continue;
      let expected: string;
      try {
        expected = binToHex(lockingBytecodeOf(getVaultContract(memo.params, provider).tokenAddress));
      } catch {
        continue;
      }
      if (expected === binToHex(vaultOutput.lockingBytecode)) found.push({ ...memo, genesisTxid: txid });
      break;
    }
  }
  return found;
}
