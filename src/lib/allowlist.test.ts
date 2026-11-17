import { describe, it, expect } from "vitest";
import { encodeCashAddress, hash160, hexToBin } from "@bitauth/libauth";
import { buildAllowlist, type SellerInfo } from "./allowlist";

const p2pkh = (n: number, type: "p2pkh" | "p2pkhWithTokens" = "p2pkh", prefix: "bitcoincash" | "bchtest" = "bchtest") =>
  encodeCashAddress({ prefix, type, payload: hash160(new Uint8Array(33).fill(n)) }).address;
const p2sh32 = (n: number) => encodeCashAddress({ prefix: "bchtest", type: "p2sh", payload: hexToBin(n.toString(16).padStart(2, "0").repeat(32)) }).address;

const KNOWN = [p2pkh(1), p2pkh(2), p2pkh(3), p2pkh(4), p2pkh(5)];
const seller: SellerInfo = { name: "Test seller", origin: "https://example.com", payTo: p2pkh(20), description: "test" };
const base = { tools: KNOWN.slice(0, 1), sellers: [] as SellerInfo[], custom: [] as { label: string; address: string }[], network: "chipnet" as const, knownPayees: KNOWN };

describe("buildAllowlist", () => {
  it("combines tools, a seller and a custom payee, with labels and seller origins", () => {
    const custom = p2pkh(30);
    const r = buildAllowlist({ ...base, sellers: [seller], custom: [{ label: "My friend", address: custom }] });
    expect(r).toEqual({
      ok: true,
      allowlist: [KNOWN[0], seller.payTo, custom],
      labels: { [seller.payTo]: "Test seller", [custom]: "My friend" },
      sellers: ["https://example.com"],
    });
  });
  it("stores a token-aware z address in its canonical q form", () => {
    const r = buildAllowlist({ ...base, custom: [{ label: "Shop", address: p2pkh(31, "p2pkhWithTokens") }] });
    expect(r.ok && r.allowlist[1]).toBe(p2pkh(31));
  });
  it("rejects a z address equal to a tool's payTo", () => {
    const r = buildAllowlist({ ...base, custom: [{ label: "Dup", address: p2pkh(1, "p2pkhWithTokens") }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/already in the list/);
  });
  it("rejects two custom rows with the same address", () => {
    const r = buildAllowlist({ ...base, custom: [{ label: "A", address: p2pkh(30) }, { label: "B", address: p2pkh(30) }] });
    expect(!r.ok && r.error).toMatch(/already in the list/);
  });
  it("rejects 9 payees in total", () => {
    const custom = [40, 41, 42, 43].map((n, i) => ({ label: `P${i}`, address: p2pkh(n) }));
    const r = buildAllowlist({ ...base, tools: KNOWN, custom });
    expect(!r.ok && r.error).toMatch(/at most 8/);
  });
  it("rejects a set whose recovery memo is over 215 bytes", () => {
    // 51 header + 2 (tool) + 5 x 33 (P2SH32) = 218 bytes
    const custom = [50, 51, 52, 53, 54].map((n, i) => ({ label: `S${i}`, address: p2sh32(n) }));
    const r = buildAllowlist({ ...base, custom });
    expect(!r.ok && r.error).toMatch(/recover/);
  });
  it("rejects an empty label", () => {
    const r = buildAllowlist({ ...base, custom: [{ label: "  ", address: p2pkh(30) }] });
    expect(!r.ok && r.error).toMatch(/label/);
  });
  it("rejects a label over 32 characters", () => {
    const r = buildAllowlist({ ...base, custom: [{ label: "x".repeat(33), address: p2pkh(30) }] });
    expect(!r.ok && r.error).toMatch(/label/);
  });
  it("rejects an address for the other network with that network's error", () => {
    const r = buildAllowlist({ ...base, custom: [{ label: "Main", address: p2pkh(30, "p2pkh", "bitcoincash") }] });
    expect(!r.ok && r.error).toMatch(/address is for mainnet, this vault is on chipnet/);
  });
  it("ignores a fully blank custom row", () => {
    const r = buildAllowlist({ ...base, custom: [{ label: "", address: " " }] });
    expect(r).toEqual({ ok: true, allowlist: [KNOWN[0]], labels: {}, sellers: [] });
  });
  it("rejects an empty selection", () => {
    const r = buildAllowlist({ ...base, tools: [] });
    expect(!r.ok && r.error).toMatch(/at least one/);
  });
});
