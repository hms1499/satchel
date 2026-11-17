import { describe, it, expect } from "vitest";
import { binToHex, encodeCashAddress, hash160, hexToBin } from "@bitauth/libauth";
import { normalizePayee } from "./payees";

const payload = hash160(new Uint8Array(33).fill(7));
const q = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload }).address;
const z = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkhWithTokens", payload }).address;
const testQ = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload }).address;

describe("normalizePayee", () => {
  it("maps a token-aware z address to its q form", () => {
    expect(z).toMatch(/^bitcoincash:z/);
    expect(normalizePayee(z, "mainnet")).toEqual({ ok: true, address: q });
  });
  it("leaves a mainnet q address unchanged", () => {
    expect(normalizePayee(q, "mainnet")).toEqual({ ok: true, address: q });
  });
  it("rejects a chipnet address on mainnet, and the reverse", () => {
    expect(normalizePayee(testQ, "mainnet")).toEqual({ ok: false, error: "address is for chipnet, this vault is on mainnet" });
    expect(normalizePayee(q, "chipnet")).toEqual({ ok: false, error: "address is for mainnet, this vault is on chipnet" });
  });
  it("rejects garbage", () => {
    expect(normalizePayee("hello", "mainnet")).toEqual({ ok: false, error: "not a valid BCH address" });
  });
  it("accepts P2SH32 and P2SH20", () => {
    const p32 = encodeCashAddress({ prefix: "bchtest", type: "p2shWithTokens", payload: hexToBin("ab".repeat(32)) }).address;
    const r = normalizePayee(p32, "chipnet");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toMatch(/^bchtest:p/);
    expect(binToHex(payload)).toHaveLength(40);
    const p20 = encodeCashAddress({ prefix: "bchtest", type: "p2sh", payload }).address;
    expect(normalizePayee(p20, "chipnet")).toEqual({ ok: true, address: p20 });
  });
});
