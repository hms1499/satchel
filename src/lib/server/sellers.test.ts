import { describe, it, expect } from "vitest";
import { encodeCashAddress, hash160 } from "@bitauth/libauth";
import { loadSellers } from "./sellers";

const payload = hash160(new Uint8Array(33).fill(3));
const payTo = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload }).address;
const seller = { name: "Test seller", origin: "https://example.com", payTo, description: "test" };
const env = (value?: string) => ({ NEXT_PUBLIC_BCH_NETWORK: "chipnet", ...(value !== undefined && { SATCHEL_SELLERS: value }) });

describe("loadSellers", () => {
  it("parses one valid seller", () => {
    expect(loadSellers(env(JSON.stringify([seller])))).toEqual([seller]);
  });
  it("normalizes a token-aware payTo to its canonical form", () => {
    const z = encodeCashAddress({ prefix: "bchtest", type: "p2pkhWithTokens", payload }).address;
    expect(loadSellers(env(JSON.stringify([{ ...seller, payTo: z }])))[0].payTo).toBe(payTo);
  });
  it("returns [] when unset or empty", () => {
    expect(loadSellers(env())).toEqual([]);
    expect(loadSellers(env(""))).toEqual([]);
  });
  it("throws naming SATCHEL_SELLERS on invalid JSON", () => {
    expect(() => loadSellers(env("[{oops"))).toThrow(/SATCHEL_SELLERS/);
  });
  it("throws naming SATCHEL_SELLERS when a payTo is not an address", () => {
    expect(() => loadSellers(env(JSON.stringify([{ ...seller, payTo: "not-an-address" }])))).toThrow(/SATCHEL_SELLERS/);
  });
  it("throws when a payTo is for the other network", () => {
    const main = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload }).address;
    expect(() => loadSellers(env(JSON.stringify([{ ...seller, payTo: main }])))).toThrow(/SATCHEL_SELLERS.*mainnet/);
  });
});
