import { describe, expect, it, vi } from "vitest";
import { mergeVaults, routeVaults, type OpenVault } from "./vault-routing";
import type { VaultDescriptor } from "../descriptor";

const pk = (c: string) => "02" + c.repeat(64);
const OWNER = pk("1");
const vault = (agent: string, token = "", owner = OWNER): VaultDescriptor => ({
  version: 1,
  network: "chipnet",
  agentIndex: 7,
  token,
  params: { ownerPk: owner, agentPk: pk(agent), capPerPeriod: "8000", periodBlocks: "144", allowlist: ["bchtest:qzhw4v5cag3h98392ktmmaean9wysfmdvuc0drgy7h"] },
});
const open = (agent: string, balance = 1000n): OpenVault => ({ descriptor: vault(agent), balance, withdrawOnly: true });

describe("mergeVaults", () => {
  it("a vault both scanned and remembered is one entry carrying the remembered token", async () => {
    const merged = await mergeVaults([{ descriptor: vault("2"), balance: 5000n }], [vault("2", "aa".repeat(32))], OWNER, async () => null);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ balance: 5000n, withdrawOnly: false });
    expect(merged[0].descriptor.token).toBe("aa".repeat(32));
  });

  it("a remembered vault that is not open on chain (closed, or v1) is dropped", async () => {
    expect(await mergeVaults([], [vault("2", "aa".repeat(32))], OWNER, async () => null)).toEqual([]);
    expect(await mergeVaults([], [vault("2", "aa".repeat(32))], OWNER, async () => 0n)).toEqual([]);
  });

  it("a remembered vault the scan missed but still open on chain is kept", async () => {
    const merged = await mergeVaults([], [vault("2", "aa".repeat(32))], OWNER, async () => 700n);
    expect(merged).toEqual([{ descriptor: vault("2", "aa".repeat(32)), balance: 700n, withdrawOnly: false }]);
  });

  it("another wallet's remembered vault is never shown nor looked up", async () => {
    const balanceOf = vi.fn(async () => 9000n);
    expect(await mergeVaults([], [vault("2", "aa".repeat(32), pk("9"))], OWNER, balanceOf)).toEqual([]);
    expect(balanceOf).not.toHaveBeenCalled();
  });

  it("sorts by balance, largest first; no token means withdraw only", async () => {
    const merged = await mergeVaults([{ descriptor: vault("2"), balance: 100n }, { descriptor: vault("3"), balance: 900n }], [], OWNER, async () => null);
    expect(merged.map((v) => v.balance)).toEqual([900n, 100n]);
    expect(merged.every((v) => v.withdrawOnly)).toBe(true);
  });
});

describe("routeVaults", () => {
  const base = { scan: "done" as const, open: [] as OpenVault[], wantsCreate: false, chosen: null };
  it("scan running: no create form yet", () => expect(routeVaults({ ...base, scan: "pending" })).toEqual({ screen: "scanning" }));
  it("scan failed", () => expect(routeVaults({ ...base, scan: "failed" })).toEqual({ screen: "scan-failed" }));
  it("no open vault: create", () => expect(routeVaults(base)).toEqual({ screen: "create" }));
  it("exactly one: its dashboard", () => expect(routeVaults({ ...base, open: [open("2")] })).toEqual({ screen: "dashboard", vault: open("2") }));
  it("two or more: the list", () => expect(routeVaults({ ...base, open: [open("2"), open("3")] })).toEqual({ screen: "list" }));
  it("an MCP link (?agent=) goes to create even with one vault", () =>
    expect(routeVaults({ ...base, open: [open("2")], wantsCreate: true })).toEqual({ screen: "create" }));
  it("a chosen vault that is open wins", () =>
    expect(routeVaults({ ...base, open: [open("2"), open("3")], chosen: vault("3") })).toEqual({ screen: "dashboard", vault: open("3") }));
  it("a chosen vault that is no longer open is ignored", () =>
    expect(routeVaults({ ...base, open: [open("2"), open("3")], chosen: vault("4") })).toEqual({ screen: "list" }));
});
