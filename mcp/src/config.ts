import { homedir } from "node:os";
import { join } from "node:path";
import type { BchNetwork } from "../../src/lib/config";

/** The Satchel web app (vault creation, tool catalog). Set to the production URL before publishing. */
export const DEFAULT_SATCHEL_URL = "https://satchel-sigma.vercel.app";

export interface McpConfig {
  network: BchNetwork;
  satchelUrl: string;
  home: string;
  maxPriceSats: bigint;
  /** Largest single satchel_send payment (SATCHEL_MAX_SEND_SATS). */
  maxSendSats: bigint;
  /** Origins satchel_pay_fetch may pay: Satchel's own, plus SATCHEL_PAY_ORIGINS (comma-separated). */
  payOrigins: string[];
  agentKeyHex?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const network = env.SATCHEL_NETWORK || "mainnet";
  if (network !== "mainnet" && network !== "chipnet") throw new Error(`SATCHEL_NETWORK must be "mainnet" or "chipnet", got "${network}"`);
  const maxPrice = env.SATCHEL_MAX_PRICE_SATS || "5000";
  if (!/^\d+$/.test(maxPrice)) throw new Error(`SATCHEL_MAX_PRICE_SATS must be a whole number of sats, got "${maxPrice}"`);
  const maxSend = env.SATCHEL_MAX_SEND_SATS || "10000";
  if (!/^\d+$/.test(maxSend)) throw new Error(`SATCHEL_MAX_SEND_SATS must be a whole number of sats, got "${maxSend}"`);
  const satchelUrl = (env.SATCHEL_URL || DEFAULT_SATCHEL_URL).replace(/\/+$/, "");
  const extraOrigins = (env.SATCHEL_PAY_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  let payOrigins: string[];
  try {
    payOrigins = [...new Set([satchelUrl, ...extraOrigins].map((o) => new URL(o).origin))];
  } catch {
    throw new Error(`SATCHEL_URL and SATCHEL_PAY_ORIGINS must be absolute URLs, got "${[satchelUrl, ...extraOrigins].join(", ")}"`);
  }
  return {
    network,
    satchelUrl,
    home: env.SATCHEL_HOME || join(homedir(), ".satchel"),
    maxPriceSats: BigInt(maxPrice),
    maxSendSats: BigInt(maxSend),
    payOrigins,
    ...(env.SATCHEL_AGENT_KEY ? { agentKeyHex: env.SATCHEL_AGENT_KEY } : {}),
  };
}
