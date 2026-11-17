import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeConnectCode, encodeConnectCode, type ConnectInfo } from "../../src/lib/connect-code";
import { ensureHome } from "./keystore";
import type { McpConfig } from "./config";

const vaultPath = (cfg: McpConfig) => join(cfg.home, `vault-${cfg.network}.json`);

/** The vault this agent is connected to on the configured network (one per network). */
export function loadVault(cfg: McpConfig): ConnectInfo | null {
  const path = vaultPath(cfg);
  if (!existsSync(path)) return null;
  const { code } = JSON.parse(readFileSync(path, "utf8")) as { code?: string };
  const decoded = decodeConnectCode(code ?? "");
  if (!decoded.ok) throw new Error(`${path} is unreadable (${decoded.error}); connect your vault again with satchel_connect`);
  return decoded.info;
}

export function saveVault(cfg: McpConfig, info: ConnectInfo): void {
  ensureHome(cfg);
  writeFileSync(vaultPath(cfg), JSON.stringify({ code: encodeConnectCode(info) }) + "\n", { mode: 0o600 });
}
