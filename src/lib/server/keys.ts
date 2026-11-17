import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SignatureTemplate } from "cashscript";
import { binToHex, publicKeyToP2pkhCashAddress, validateSecp256k1PrivateKey } from "@bitauth/libauth";
import { NETWORK } from "../config";
import { PROVIDER_COUNT } from "../tools";

function secret(name: "AGENT_MASTER_SEED" | "PROVIDER_SEED"): string {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} must be set (>= 32 chars)`);
  return value;
}

function derivePrivateKey(seed: string, label: string): Uint8Array {
  for (let i = 0; ; i++) {
    const candidate = new Uint8Array(createHash("sha256").update(`${seed}|${label}|${i}`).digest());
    if (validateSecp256k1PrivateKey(candidate)) return candidate;
  }
}

const prefix = NETWORK === "mainnet" ? "bitcoincash" : "bchtest";

function keyInfo(priv: Uint8Array) {
  const signer = new SignatureTemplate(priv);
  const pub = signer.publicKey;
  const { address } = publicKeyToP2pkhCashAddress({ publicKey: pub, prefix });
  return { signer, pubHex: binToHex(pub), address };
}

/** Each vault gets its own agent key, derived statelessly from the server seed. */
export function agentKey(agentIndex: number) {
  if (!Number.isSafeInteger(agentIndex) || agentIndex < 0) throw new Error("Invalid agent index");
  return keyInfo(derivePrivateKey(secret("AGENT_MASTER_SEED"), `agent:${agentIndex}`));
}

/** Bearer token proving the caller created this agent (so others can't burn its budget). */
export function accessToken(agentIndex: number): string {
  return createHmac("sha256", secret("AGENT_MASTER_SEED")).update(`access:${agentIndex}`).digest("hex");
}

export function verifyAccess(agentIndex: number, token: string): boolean {
  const expected = Buffer.from(accessToken(agentIndex), "hex");
  const given = Buffer.from(token ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Addresses of the paid-API providers (payees of the pay-per-call tools). */
export function providerKeys() {
  return Array.from({ length: PROVIDER_COUNT }, (_, i) => keyInfo(derivePrivateKey(secret("PROVIDER_SEED"), `provider:${i}`)));
}

/** A fixed "attacker" address used by the demo's malicious-agent simulation. */
export function attackerAddress(): string {
  return keyInfo(derivePrivateKey("public-attacker-demo-key-not-secret!!", "attacker")).address;
}

/** The validated provider secret (>= 32 chars). Signs the pay-per-call challenges (satchel-pay-server `secret`). */
export function providerSeed(): string {
  return secret("PROVIDER_SEED");
}
