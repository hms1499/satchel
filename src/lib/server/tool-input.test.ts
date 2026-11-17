import { describe, it, expect } from "vitest";
import { PAID_TOOLS, TOOL_NAMES } from "../tools";
import { ToolInputError, validateToolInput } from "./tool-impl";

describe("paid tool parameters", () => {
  it("every paid tool documents its parameters", () => {
    for (const name of TOOL_NAMES) expect(Object.keys(PAID_TOOLS[name].params).length).toBeGreaterThan(0);
    expect(Object.keys(PAID_TOOLS["deep-analysis"].params)).toEqual(["question", "material"]);
  });

  it("rejects unknown parameter names before payment (an agent guessing {coin} must not get the BCH price)", async () => {
    await expect(validateToolInput("crypto-price", new URLSearchParams({ coin: "ethereum" }))).rejects.toThrow(ToolInputError);
    await expect(validateToolInput("crypto-price", new URLSearchParams({ coin: "ethereum" }))).rejects.toThrow(/unknown parameter "coin"; expected: id/);
  });

  it("rejects missing or invalid required values before payment", async () => {
    await expect(validateToolInput("deep-analysis", new URLSearchParams({ prompt: "x" }))).rejects.toThrow(ToolInputError);
    await expect(validateToolInput("deep-analysis", new URLSearchParams({ material: "m" }))).rejects.toThrow(/question is required/);
    await expect(validateToolInput("web-reader", new URLSearchParams({ url: "http://169.254.169.254/" }))).rejects.toThrow(ToolInputError);
    await expect(validateToolInput("crypto-price", new URLSearchParams({ id: "Not An Id!" }))).rejects.toThrow(ToolInputError);
  });

  it("accepts valid input", async () => {
    await expect(validateToolInput("crypto-price", new URLSearchParams({ id: "ethereum" }))).resolves.toBeUndefined();
    await expect(validateToolInput("crypto-price", new URLSearchParams())).resolves.toBeUndefined(); // id defaults to bitcoin-cash
    await expect(validateToolInput("web-reader", new URLSearchParams({ url: "https://example.org/a" }))).resolves.toBeUndefined();
    await expect(validateToolInput("deep-analysis", new URLSearchParams({ question: "q", material: "m" }))).resolves.toBeUndefined();
  });
});
