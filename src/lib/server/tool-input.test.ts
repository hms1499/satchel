import { describe, it, expect } from "vitest";
import { PAID_TOOLS, TOOL_NAMES } from "../tools";
import { ToolInputError, validateToolInput } from "./tool-impl";

describe("paid tool parameters", () => {
  it("every paid tool documents its parameters", () => {
    for (const name of TOOL_NAMES) expect(Object.keys(PAID_TOOLS[name].params).length).toBeGreaterThan(0);
    expect(Object.keys(PAID_TOOLS["deep-analysis"].params)).toEqual(["question", "material"]);
  });

  it("rejects unknown parameter names before payment (an agent guessing {coin} must not get the BCH price)", () => {
    expect(() => validateToolInput("crypto-price", new URLSearchParams({ coin: "ethereum" }))).toThrow(ToolInputError);
    expect(() => validateToolInput("crypto-price", new URLSearchParams({ coin: "ethereum" }))).toThrow(/unknown parameter "coin"; expected: id/);
  });

  it("rejects missing or invalid required values before payment", () => {
    expect(() => validateToolInput("deep-analysis", new URLSearchParams({ prompt: "x" }))).toThrow(ToolInputError);
    expect(() => validateToolInput("deep-analysis", new URLSearchParams({ material: "m" }))).toThrow(/question is required/);
    expect(() => validateToolInput("web-reader", new URLSearchParams({ url: "http://169.254.169.254/" }))).toThrow(ToolInputError);
    expect(() => validateToolInput("crypto-price", new URLSearchParams({ id: "Not An Id!" }))).toThrow(ToolInputError);
  });

  it("accepts valid input", () => {
    expect(() => validateToolInput("crypto-price", new URLSearchParams({ id: "ethereum" }))).not.toThrow();
    expect(() => validateToolInput("crypto-price", new URLSearchParams())).not.toThrow(); // id defaults to bitcoin-cash
    expect(() => validateToolInput("web-reader", new URLSearchParams({ url: "https://example.org/a" }))).not.toThrow();
    expect(() => validateToolInput("deep-analysis", new URLSearchParams({ question: "q", material: "m" }))).not.toThrow();
  });
});
