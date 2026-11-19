import { describe, expect, it } from "vitest";
import { parseWholeSats } from "./sats";

describe("parseWholeSats", () => {
  it("accepts whole numbers of sats", () => {
    expect(parseWholeSats("20000")).toBe(20_000n);
    expect(parseWholeSats(" 8000 ")).toBe(8_000n);
  });
  it("refuses decimals, exponents, signs and empty input instead of throwing", () => {
    for (const bad of ["1.5", "1e4", "-5", "", "abc"]) expect(parseWholeSats(bad)).toBeNull();
  });
});
