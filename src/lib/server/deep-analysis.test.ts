import { afterEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...a) }));

import { runTool } from "./tool-impl";

const params = () => new URLSearchParams({ question: "BCH vs ETH?", material: "BCH price $400" });

describe("deep-analysis with a live model", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    generateText.mockReset();
  });

  it("returns the model's answer", async () => {
    vi.stubEnv("TOOL_LLM", "on");
    vi.stubEnv("AI_GATEWAY_API_KEY", "k");
    generateText.mockResolvedValue({ text: "- brief" });
    expect(await runTool("deep-analysis", params())).toMatchObject({ analysis: "- brief" });
  });

  it("answers without the model instead of failing a call that is already paid", async () => {
    vi.stubEnv("TOOL_LLM", "on");
    vi.stubEnv("AI_GATEWAY_API_KEY", "k");
    generateText.mockRejectedValue(new Error("AI Gateway requires a valid credit card\nmore"));
    const r = (await runTool("deep-analysis", params())) as { analysis: string; model: string };
    expect(r.model).toBe("none");
    expect(r.analysis).toContain("model is unavailable");
    expect(r.analysis).toContain("BCH price $400");
  });
});
