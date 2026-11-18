import { describe, it, expect } from "vitest";
import { EST_FEE_PER_CALL, estimateFeePerCall } from "./tools";

describe("estimateFeePerCall", () => {
  it("is the 3-payee constant up to 3 payees", () => {
    for (const n of [0, 1, 2, 3]) expect(estimateFeePerCall(n)).toBe(EST_FEE_PER_CALL);
  });
  it("adds 32 sats per payee beyond 3, as a bigint", () => {
    expect(estimateFeePerCall(5)).toBe(764n);
    expect(estimateFeePerCall(8)).toBe(860n);
    expect(typeof estimateFeePerCall(4)).toBe("bigint");
  });
});
