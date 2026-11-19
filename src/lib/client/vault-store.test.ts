import { describe, expect, it } from "vitest";
import { forgetVault, loadVaults, rememberVault, type KV } from "./vault-store";
import type { VaultDescriptor } from "../descriptor";

function memory(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v), removeItem: (k) => void delete data[k] };
}
const pk = (c: string) => "02" + c.repeat(64);
const vault = (agent: string, token = "ab".repeat(32)): VaultDescriptor => ({
  version: 1,
  network: "chipnet",
  agentIndex: 7,
  token,
  params: { ownerPk: pk("1"), agentPk: pk(agent), capPerPeriod: "8000", periodBlocks: "144", allowlist: ["bchtest:qzhw4v5cag3h98392ktmmaean9wysfmdvuc0drgy7h"] },
});

describe("vault store", () => {
  it("migrates the old single-vault key once, then removes it", () => {
    const kv = memory({ "satchel:vault": JSON.stringify(vault("2")) });
    expect(loadVaults(kv)).toHaveLength(1);
    expect(kv.data["satchel:vault"]).toBeUndefined();
    expect(loadVaults(kv)).toHaveLength(1);
  });

  it("remembers two vaults with their own tokens, newest first", () => {
    const kv = memory();
    rememberVault(vault("2", "aa".repeat(32)), kv);
    rememberVault(vault("3", "bb".repeat(32)), kv);
    expect(loadVaults(kv).map((d) => d.token)).toEqual(["bb".repeat(32), "aa".repeat(32)]);
  });

  it("remembering the same vault again replaces it", () => {
    const kv = memory();
    rememberVault(vault("2", ""), kv);
    rememberVault(vault("2", "cc".repeat(32)), kv);
    expect(loadVaults(kv)).toEqual([vault("2", "cc".repeat(32))]);
  });

  it("forgets a vault", () => {
    const kv = memory();
    rememberVault(vault("2"), kv);
    rememberVault(vault("3"), kv);
    forgetVault(vault("2"), kv);
    expect(loadVaults(kv).map((d) => d.params.agentPk)).toEqual([pk("3")]);
  });

  it("drops malformed entries", () => {
    const kv = memory({ "satchel:vaults": JSON.stringify([{ nope: 1 }, vault("2")]) });
    expect(loadVaults(kv)).toEqual([vault("2")]);
  });

  it("a throwing storage reads as empty and never throws", () => {
    const broken: KV = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(loadVaults(broken)).toEqual([]);
    expect(() => rememberVault(vault("2"), broken)).not.toThrow();
    expect(() => forgetVault(vault("2"), broken)).not.toThrow();
  });
});
