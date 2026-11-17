import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type McpConfig } from "./config";
import { loadOrCreateAgentKey } from "./keystore";
import { loadVault, saveVault } from "./vault-store";
import type { ConnectInfo } from "../../src/lib/connect-code";

let home: string;
let cfg: McpConfig;
beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "satchel-")), "home");
  cfg = loadConfig({ SATCHEL_HOME: home });
});

describe("config", () => {
  it("has the documented defaults", () => {
    expect(cfg).toMatchObject({ network: "mainnet", home, maxPriceSats: 5000n });
    expect(cfg.agentKeyHex).toBeUndefined();
  });

  it("rejects an unknown network", () => {
    expect(() => loadConfig({ SATCHEL_NETWORK: "testnet" })).toThrow(/SATCHEL_NETWORK/);
  });

  it("rejects a non-integer max price", () => {
    expect(() => loadConfig({ SATCHEL_MAX_PRICE_SATS: "1.5" })).toThrow(/SATCHEL_MAX_PRICE_SATS/);
  });
});

describe("agent key store", () => {
  it("creates the key once and keeps it", () => {
    const first = loadOrCreateAgentKey(cfg);
    const second = loadOrCreateAgentKey(cfg);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.pubHex).toBe(first.pubHex);
    expect(first.pubHex).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it("stores the key file 0600 in a 0700 directory", () => {
    loadOrCreateAgentKey(cfg);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "agent.json")).mode & 0o777).toBe(0o600);
  });

  it("uses SATCHEL_AGENT_KEY without writing a file", () => {
    const env = loadConfig({ SATCHEL_HOME: home, SATCHEL_AGENT_KEY: "11".repeat(32) });
    const k = loadOrCreateAgentKey(env);
    expect(k.created).toBe(false);
    expect(existsSync(join(home, "agent.json"))).toBe(false);
  });

  it("refuses a corrupted key file and leaves it untouched", () => {
    loadOrCreateAgentKey(cfg);
    const path = join(home, "agent.json");
    writeFileSync(path, "{not json");
    expect(() => loadOrCreateAgentKey(cfg)).toThrow(/agent\.json is unreadable: .*Satchel will not overwrite it/);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});

describe("vault store", () => {
  const info: ConnectInfo = {
    v: 1,
    network: "mainnet",
    params: { ownerPk: "02" + "11".repeat(32), agentPk: "03" + "22".repeat(32), capPerPeriod: "8000", periodBlocks: "144", allowlist: ["bitcoincash:qzhw4v5cag3h98392ktmmaean9wysfmdvuuafy2net"] },
  };

  it("saves and loads the connected vault per network", () => {
    expect(loadVault(cfg)).toBeNull();
    saveVault(cfg, info);
    expect(loadVault(cfg)).toEqual(info);
    expect(loadVault(loadConfig({ SATCHEL_HOME: home, SATCHEL_NETWORK: "chipnet" }))).toBeNull();
    expect(statSync(join(home, "vault-mainnet.json")).mode & 0o777).toBe(0o600);
  });
});
