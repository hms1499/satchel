import { describe, expect, it, vi } from "vitest";
import { binToHex, cashAddressToLockingBytecode, sha256 } from "@bitauth/libauth";
import { coinHeight } from "./coin-height";

const ADDRESS = "bitcoincash:qqly88svdxfpvfxpfj7zr34tx0ssx0lw8smhswrc79";
const T = "ab".repeat(32);
const scripthash = () => {
  const lb = cashAddressToLockingBytecode(ADDRESS);
  if (typeof lb === "string") throw new Error(lb);
  return binToHex(sha256.hash(lb.bytecode).reverse());
};

describe("coinHeight", () => {
  it("returns the confirmation height of the outpoint from listunspent", async () => {
    const performRequest = vi.fn(async () => [{ tx_hash: "cd".repeat(32), tx_pos: 0, height: 5 }, { tx_hash: T, tx_pos: 0, height: 900 }]);
    expect(await coinHeight({ performRequest }, ADDRESS, { txid: T, vout: 0 })).toBe(900);
    expect(performRequest).toHaveBeenCalledWith("blockchain.scripthash.listunspent", scripthash());
  });

  it("an unconfirmed coin (height 0 or -1) is 0", async () => {
    expect(await coinHeight({ performRequest: async () => [{ tx_hash: T, tx_pos: 0, height: 0 }] }, ADDRESS, { txid: T, vout: 0 })).toBe(0);
    expect(await coinHeight({ performRequest: async () => [{ tx_hash: T, tx_pos: 0, height: -1 }] }, ADDRESS, { txid: T, vout: 0 })).toBe(0);
  });

  it("an outpoint Electrum does not list yet is 0", async () => {
    expect(await coinHeight({ performRequest: async () => [{ tx_hash: T, tx_pos: 1, height: 900 }] }, ADDRESS, { txid: T, vout: 0 })).toBe(0);
  });

  it("an Electrum error is 0", async () => {
    expect(await coinHeight({ performRequest: async () => { throw new Error("socket closed"); } }, ADDRESS, { txid: T, vout: 0 })).toBe(0);
  });

  it("a provider without performRequest (tests, browser) is 0", async () => {
    expect(await coinHeight({}, ADDRESS, { txid: T, vout: 0 })).toBe(0);
  });
});
