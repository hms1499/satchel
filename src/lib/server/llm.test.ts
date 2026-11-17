import { afterEach, describe, expect, it, vi } from "vitest";
import { agentUsesLlm, toolUsesLlm } from "./llm";

describe("llm switches", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("toolUsesLlm needs TOOL_LLM=on and credentials", () => {
    expect(toolUsesLlm({ AI_GATEWAY_API_KEY: "k" })).toBe(false);
    expect(toolUsesLlm({ TOOL_LLM: "on" })).toBe(false);
    expect(toolUsesLlm({ TOOL_LLM: "on", AI_GATEWAY_API_KEY: "k" })).toBe(true);
    expect(toolUsesLlm({ TOOL_LLM: "on", VERCEL_OIDC_TOKEN: "t" })).toBe(true);
  });

  it("agentUsesLlm ignores TOOL_LLM", () => {
    expect(agentUsesLlm({ TOOL_LLM: "on", AI_GATEWAY_API_KEY: "k" })).toBe(false);
    expect(agentUsesLlm({ AGENT_MODE: "llm", AI_GATEWAY_API_KEY: "k" })).toBe(true);
  });

  it("/api/config marks deep-analysis as demo or live", async () => {
    const { GET } = await import("@/app/api/config/route");
    vi.stubEnv("PROVIDER_SEED", "p".repeat(32));
    vi.stubEnv("TOOL_LLM", "");
    const demo = await (await GET()).json();
    expect(demo.deepAnalysis).toBe("demo");
    const d = demo.tools.find((t: { name: string }) => t.name === "deep-analysis");
    expect(d.description.endsWith(" (demo mode: placeholder answer)")).toBe(true);
    vi.stubEnv("TOOL_LLM", "on");
    vi.stubEnv("AI_GATEWAY_API_KEY", "k");
    const live = await (await GET()).json();
    expect(live.deepAnalysis).toBe("live");
    expect(live.tools.find((t: { name: string }) => t.name === "deep-analysis").description).not.toContain("demo mode");
  });
});
