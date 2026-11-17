import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SignatureTemplate, binToHex, hexToBin, secp256k1, validateSecp256k1PrivateKey } from "../../src/lib/chain-deps";
import type { McpConfig } from "./config";

export interface AgentKey {
  signer: SignatureTemplate;
  pubHex: string;
  created: boolean;
}

function fromPrivateKey(priv: Uint8Array, created: boolean): AgentKey {
  if (!validateSecp256k1PrivateKey(priv)) throw new Error("the agent private key is not a valid secp256k1 key");
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === "string") throw new Error(pub);
  return { signer: new SignatureTemplate(priv), pubHex: binToHex(pub), created };
}

/** Ensures `home` exists, private to this user (0700). */
export function ensureHome(cfg: McpConfig): void {
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
}

/**
 * The agent key never leaves this machine. SATCHEL_AGENT_KEY wins (no file written); otherwise `agent.json` in the
 * Satchel home is created once (0600) and reused. An unreadable file is reported, never replaced.
 */
export function loadOrCreateAgentKey(cfg: McpConfig): AgentKey {
  if (cfg.agentKeyHex) {
    if (!/^[0-9a-f]{64}$/i.test(cfg.agentKeyHex)) throw new Error("SATCHEL_AGENT_KEY must be 64 hex characters");
    return fromPrivateKey(hexToBin(cfg.agentKeyHex.toLowerCase()), false);
  }
  const path = join(cfg.home, "agent.json");
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { v?: number; privateKey?: string };
      if (parsed.v !== 1 || !/^[0-9a-f]{64}$/.test(parsed.privateKey ?? "")) throw new Error("unexpected format");
      return fromPrivateKey(hexToBin(parsed.privateKey!), false);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`${path} is unreadable: ${why}; fix or move it, Satchel will not overwrite it`);
    }
  }
  ensureHome(cfg);
  let priv: Uint8Array;
  do priv = new Uint8Array(randomBytes(32));
  while (!validateSecp256k1PrivateKey(priv));
  // "wx": fail instead of overwriting if another process created the file in the meantime.
  writeFileSync(path, JSON.stringify({ v: 1, privateKey: binToHex(priv) }) + "\n", { mode: 0o600, flag: "wx" });
  return fromPrivateKey(priv, true);
}
