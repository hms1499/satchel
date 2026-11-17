import { homedir } from "node:os";
import { join } from "node:path";
import type { BchNetwork } from "../../src/lib/config";

/** The Satchel web app (vault creation, tool catalog). Set to the production URL before publishing. */
export const DEFAULT_SATCHEL_URL = "http://localhost:3000";

export interface McpConfig {
  network: BchNetwork;
  satchelUrl: string;
  home: string;
  maxPriceSats: bigint;
  agentKeyHex?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const network = env.SATCHEL_NETWORK || "mainnet";
  if (network !== "mainnet" && network !== "chipnet") throw new Error(`SATCHEL_NETWORK must be "mainnet" or "chipnet", got "${network}"`);
  const maxPrice = env.SATCHEL_MAX_PRICE_SATS || "5000";
  if (!/^\d+$/.test(maxPrice)) throw new Error(`SATCHEL_MAX_PRICE_SATS must be a whole number of sats, got "${maxPrice}"`);
  const satchelUrl = (env.SATCHEL_URL || DEFAULT_SATCHEL_URL).replace(/\/+$/, "");
  return {
    network,
    satchelUrl,
    home: env.SATCHEL_HOME || join(homedir(), ".satchel"),
    maxPriceSats: BigInt(maxPrice),
    ...(env.SATCHEL_AGENT_KEY ? { agentKeyHex: env.SATCHEL_AGENT_KEY } : {}),
  };
}
