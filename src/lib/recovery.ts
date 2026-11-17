import { binToHex, decodeCashAddress, decodeTransaction, encodeCashAddress, flattenBinArray, hexToBin, utf8ToBin } from "@bitauth/libauth";
import type { NetworkProvider } from "cashscript";
import { getVaultContract, lockingBytecodeOf, type VaultParams } from "./vault";
import { EXTERNAL_AGENT_INDEX, paramsToDescriptorParams, type VaultDescriptor } from "./descriptor";
import type { BchNetwork } from "./config";
import { prefixFor } from "./payees";

/**
 * On-chain vault recovery.
 *
 * The owner can only withdraw if they can rebuild the contract, which needs the agent key and the
 * vault settings. Those used to live only in the browser (localStorage). The genesis transaction now
 * also carries them in an OP_RETURN output:
 *
 *   OP_RETURN "STCH" <version 2 | agentIndex u32 LE | agentPk 33B | cap u64 LE | periodBlocks u32 LE | n | n entries>
 *   entry: 0x00 i (known payee index) | 0x01 <20B> P2PKH | 0x02 <20B> P2SH20 | 0x03 <32B> P2SH32
 *
 * Known payees (the paid-tool catalog) are indexes into the server's list; others are stored as hashes.
 * The payload is at most 215 bytes; it is pushed directly (<= 75) or with PUSHDATA1. Version 1 (indexes only,
 * one byte per payee) is still decoded.
 * The memo is not trusted: a vault is only recovered when the contract rebuilt from it has exactly the
 * locking bytecode of the genesis output 0. The agent access token is deliberately NOT on-chain
 * (anyone could read it and burn the budget), so a recovered vault can be inspected and withdrawn,
 * but driving the agent again needs a new vault.
 */
export const RECOVERY_PREFIX = "STCH";
const VERSION = 2;
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

const KIND_KNOWN = 0x00;
const KIND_P2PKH = 0x01;
const KIND_P2SH20 = 0x02;
const KIND_P2SH32 = 0x03;
const HEADER_SIZE = 1 + 4 + 33 + 8 + 4 + 1;
/** Max payload bytes: the whole OP_RETURN script is then 1 + 5 + 2 + 215 = 223 bytes. */
export const MAX_RECOVERY_PAYLOAD = 215;

/** One v2 allowlist entry: a known-payee index, or a custom payee as kind + hash. */
function encodeEntry(address: string, knownPayees: string[]): Uint8Array {
  const i = knownPayees.indexOf(address);
  if (i >= 0 && i < 256) return Uint8Array.of(KIND_KNOWN, i);
  const decoded = decodeCashAddress(address);
  if (typeof decoded === "string") throw new Error(`${address} is not a valid BCH address`);
  const { type, payload } = decoded;
  const isP2pkh = type === "p2pkh" || type === "p2pkhWithTokens";
  if (isP2pkh && payload.length === 20) return Uint8Array.of(KIND_P2PKH, ...payload);
  if (!isP2pkh && payload.length === 20) return Uint8Array.of(KIND_P2SH20, ...payload);
  if (!isP2pkh && payload.length === 32) return Uint8Array.of(KIND_P2SH32, ...payload);
  throw new Error(`${address} has an unsupported address type`);
}

function checkCount(n: number) {
  if (n < 1 || n > MAX_PAYEES) throw new Error("Allowlist must have 1 to 8 entries");
}

/** Size in bytes of the v2 recovery payload for this allowlist. */
export function recoveryPayloadSize(allowlist: string[], knownPayees: string[]): number {
  checkCount(allowlist.length);
  return HEADER_SIZE + allowlist.reduce((n, a) => n + encodeEntry(a, knownPayees).length, 0);
}

/** OP_RETURN chunks for `TransactionBuilder.addOpReturnOutput` (strings starting with 0x are hex). */
export function encodeRecoveryMemo(params: VaultParams, agentIndex: number, knownPayees: string[]): string[] {
  checkCount(params.allowlist.length);
  const size = recoveryPayloadSize(params.allowlist, knownPayees);
  if (size > MAX_RECOVERY_PAYLOAD) {
    throw new Error(`too many custom payees to recover this vault from chain (payload ${size} > ${MAX_RECOVERY_PAYLOAD} bytes)`);
  }
  const payload = flattenBinArray([
    Uint8Array.of(VERSION),
    le(BigInt(agentIndex), 4),
    hexToBin(params.agentPk),
    le(params.capPerPeriod, 8),
    le(params.periodBlocks, 4),
    Uint8Array.of(params.allowlist.length),
    ...params.allowlist.map((a) => encodeEntry(a, knownPayees)),
  ]);
  return [RECOVERY_PREFIX, `0x${binToHex(payload)}`];
}

/** Reads the payload of `0x6a push("STCH") push(payload)`; the payload push is direct (<= 75) or PUSHDATA1. */
function readPayload(b: Uint8Array): Uint8Array | null {
  if (b.length < 8 || b[0] !== 0x6a || b[1] !== PREFIX_BIN.length) return null;
  if (binToHex(b.slice(2, 6)) !== binToHex(PREFIX_BIN)) return null;
  let len = b[6];
  let start = 7;
  if (len === 0x4c) {
    len = b[7];
    start = 8;
    if (len <= 75) return null; // non-minimal push
  } else if (len > 75) return null;
  if (b.length !== start + len) return null;
  return b.slice(start);
}

/** Parses a recovery OP_RETURN. Returns null for anything that is not a well-formed v1 or v2 memo. */
export function decodeRecoveryMemo(
  lockingBytecode: Uint8Array,
  ownerPk: string,
  knownPayees: string[],
  network: BchNetwork,
): { agentIndex: number; params: VaultParams } | null {
  const p = readPayload(lockingBytecode);
  if (!p || p.length < HEADER_SIZE) return null;
  const version = p[0];
  if (version !== 1 && version !== 2) return null;
  const count = p[HEADER_SIZE - 1];
  if (count === 0 || count > MAX_PAYEES) return null;
  const agentPk = binToHex(p.slice(5, 38));
  if (!/^0[23]/.test(agentPk)) return null;
  const allowlist: string[] = [];
  const body = p.slice(HEADER_SIZE);
  if (version === 1) {
    if (body.length !== count) return null;
    for (const i of body) {
      if (i >= knownPayees.length) return null;
      allowlist.push(knownPayees[i]);
    }
  } else {
    let pos = 0;
    for (let n = 0; n < count; n++) {
      const kind = body[pos++];
      if (kind === KIND_KNOWN) {
        const i = body[pos++];
        if (i === undefined || i >= knownPayees.length) return null;
        allowlist.push(knownPayees[i]);
        continue;
      }
      const size = kind === KIND_P2PKH || kind === KIND_P2SH20 ? 20 : kind === KIND_P2SH32 ? 32 : 0;
      if (size === 0 || pos + size > body.length) return null;
      const payload = body.slice(pos, pos + size);
      pos += size;
      allowlist.push(
        encodeCashAddress({ prefix: prefixFor(network), type: kind === KIND_P2PKH ? "p2pkh" : "p2sh", payload }).address,
      );
    }
    if (pos !== body.length) return null;
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

/** A descriptor for a vault rebuilt from chain: no access token (never published), so only owner actions work. */
export function descriptorFromRecovered(v: RecoveredVault, network: BchNetwork): VaultDescriptor {
  return {
    version: 1,
    network,
    agentIndex: v.agentIndex,
    token: "",
    params: paramsToDescriptorParams(v.params),
    genesisTxid: v.genesisTxid,
    recovered: true,
    external: v.agentIndex === EXTERNAL_AGENT_INDEX,
  };
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
  const network: BchNetwork = provider.network === "mainnet" ? "mainnet" : "chipnet";
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
      const memo = decodeRecoveryMemo(output.lockingBytecode, ownerPk, knownPayees, network);
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
