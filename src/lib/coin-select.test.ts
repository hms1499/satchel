import { describe, expect, it } from "vitest";
import { selectCoins } from "./coin-select";

describe("selectCoins", () => {
  it("takes only the largest coin when it covers the target and its fee", () => {
    expect(selectCoins([2_000n, 2_300_000n, 19_531n], 18_000n)).toEqual([1]);
  });

  it("adds coins largest first until the target and the fees are covered", () => {
    expect(selectCoins([5_000n, 9_000n, 8_000n], 16_000n)).toEqual([1, 2]);
  });

  it("counts the fee of every input it adds", () => {
    // 10,000 alone cannot pay 10,000 plus its own fee; the next coin must be added.
    expect(selectCoins([10_000n, 1_000n], 10_000n)).toEqual([0, 1]);
  });

  it("returns null when the coins cannot cover the target", () => {
    expect(selectCoins([1_000n, 2_000n], 5_000n)).toBeNull();
  });
});
