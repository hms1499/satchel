import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeCashAddress,
  disassembleBytecodeBCH,
  encodeCashAddress,
  hexToBin,
  lockingBytecodeToBase58Address,
} from "@bitauth/libauth";
import { InputError } from "satchel-pay-server";

export type ScriptType = "p2pkh" | "p2sh20" | "p2sh32" | "op_return" | "nonstandard";

export type DecodedAddress = {
  forms: { cashaddr: string; tokenAware: string; legacy: string | null };
  type: "p2pkh" | "p2sh20" | "p2sh32";
  network: "mainnet" | "chipnet";
  lockingBytecode: string;
};

export type DecodedScript = {
  asm: string;
  type: ScriptType;
  opReturn: { hex: string; text: string | null }[] | null;
};

const MAX_SCRIPT_BYTES = 10_000;

export function decodeAddress(address: string): DecodedAddress {
  const input = typeof address === "string" ? address.trim() : "";
  const decoded = decodeCashAddress(input);
  if (typeof decoded === "string") throw new InputError(`not a valid CashAddr: ${decoded}`);
  const network = decoded.prefix === "bitcoincash" ? "mainnet" : decoded.prefix === "bchtest" ? "chipnet" : null;
  if (!network) throw new InputError(`unsupported CashAddr prefix "${decoded.prefix}"`);

  const isP2pkh = decoded.type === "p2pkh" || decoded.type === "p2pkhWithTokens";
  const type: DecodedAddress["type"] = isP2pkh ? "p2pkh" : decoded.payload.length === 32 ? "p2sh32" : "p2sh20";
  const [plain, token] = isP2pkh ? (["p2pkh", "p2pkhWithTokens"] as const) : (["p2sh", "p2shWithTokens"] as const);
  const enc = (t: typeof plain | typeof token) => encodeCashAddress({ prefix: decoded.prefix, type: t, payload: decoded.payload }).address;

  const lock = cashAddressToLockingBytecode(input);
  if (typeof lock === "string") throw new InputError(`not a valid CashAddr: ${lock}`);
  let legacy: string | null = null;
  if (type !== "p2sh32") {
    const l = lockingBytecodeToBase58Address(lock.bytecode, network === "mainnet" ? "mainnet" : "testnet");
    if (typeof l === "string") legacy = l;
  }
  return {
    forms: { cashaddr: enc(plain), tokenAware: enc(token), legacy },
    type,
    network,
    lockingBytecode: binToHex(lock.bytecode),
  };
}

function classify(bytes: Uint8Array): ScriptType {
  const n = bytes.length;
  if (n === 25 && bytes[0] === 0x76 && bytes[1] === 0xa9 && bytes[2] === 0x14 && bytes[23] === 0x88 && bytes[24] === 0xac) return "p2pkh";
  if (n === 23 && bytes[0] === 0xa9 && bytes[1] === 0x14 && bytes[22] === 0x87) return "p2sh20";
  if (n === 35 && bytes[0] === 0xaa && bytes[1] === 0x20 && bytes[34] === 0x87) return "p2sh32";
  if (n >= 1 && bytes[0] === 0x6a) return "op_return";
  return "nonstandard";
}

/** The data pushes after OP_RETURN, or null when the pushes cannot be parsed. */
function opReturnPushes(bytes: Uint8Array): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  let i = 1;
  while (i < bytes.length) {
    const op = bytes[i++];
    let len: number;
    if (op === 0x00) len = 0;
    else if (op <= 0x4b) len = op;
    else if (op === 0x4c) { if (i + 1 > bytes.length) return null; len = bytes[i]; i += 1; }
    else if (op === 0x4d) { if (i + 2 > bytes.length) return null; len = bytes[i] | (bytes[i + 1] << 8); i += 2; }
    else if (op === 0x4e) { if (i + 4 > bytes.length) return null; len = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0; i += 4; }
    else return null;
    if (i + len > bytes.length) return null;
    out.push(bytes.slice(i, i + len));
    i += len;
  }
  return out;
}

function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeScript(hex: string): DecodedScript {
  const clean = typeof hex === "string" ? hex.trim().replace(/^0x/i, "") : "";
  if (clean.length === 0) throw new InputError("hex is required");
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) throw new InputError("hex must be an even number of hex digits");
  if (clean.length / 2 > MAX_SCRIPT_BYTES) throw new InputError(`script is over ${MAX_SCRIPT_BYTES} bytes`);

  const bytes = hexToBin(clean);
  const type = classify(bytes);
  const pushes = type === "op_return" ? opReturnPushes(bytes) : null;
  return {
    asm: disassembleBytecodeBCH(bytes),
    type,
    opReturn: pushes ? pushes.map((p) => ({ hex: binToHex(p), text: utf8OrNull(p) })) : null,
  };
}
