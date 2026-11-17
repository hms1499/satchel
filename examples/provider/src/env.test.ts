import { describe, expect, it } from "vitest";
import { loadSellerEnv } from "./env";

const MAIN = "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
const TEST = "bchtest:qz509yk0wh4egyh63jyu0uu4kljp0ngauure7y5xe2";

describe("loadSellerEnv", () => {
  it("accepts mainnet (also the default) and chipnet", () => {
    expect(loadSellerEnv({ SELLER_PAY_TO: MAIN }).network).toBe("mainnet");
    expect(loadSellerEnv({ SELLER_NETWORK: " mainnet ", SELLER_PAY_TO: MAIN }).network).toBe("mainnet");
    expect(loadSellerEnv({ SELLER_NETWORK: "chipnet", SELLER_PAY_TO: TEST })).toMatchObject({ network: "chipnet", payTo: TEST });
  });
  it("rejects a missing, empty or invalid SELLER_PAY_TO", () => {
    expect(() => loadSellerEnv({})).toThrow(/SELLER_PAY_TO/);
    expect(() => loadSellerEnv({ SELLER_PAY_TO: "  " })).toThrow(/SELLER_PAY_TO/);
    expect(() => loadSellerEnv({ SELLER_PAY_TO: "nope" })).toThrow(/SELLER_PAY_TO/);
  });
  it("rejects an address for the other network", () => {
    expect(() => loadSellerEnv({ SELLER_NETWORK: "mainnet", SELLER_PAY_TO: TEST })).toThrow(/SELLER_PAY_TO.*bchtest/);
    expect(() => loadSellerEnv({ SELLER_NETWORK: "chipnet", SELLER_PAY_TO: MAIN })).toThrow(/SELLER_PAY_TO/);
  });
  it("rejects an unknown SELLER_NETWORK", () => {
    expect(() => loadSellerEnv({ SELLER_NETWORK: "testnet", SELLER_PAY_TO: TEST })).toThrow(/SELLER_NETWORK/);
  });
});
