import { afterEach, describe, expect, it, vi } from "vitest";
import { agentModel, agentUsesLlm, toolModel, toolUsesLlm } from "./llm";

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

  it("a Groq key counts as credentials", () => {
    expect(agentUsesLlm({ AGENT_MODE: "llm", GROQ_API_KEY: "g" })).toBe(true);
    expect(toolUsesLlm({ TOOL_LLM: "on", GROQ_API_KEY: "g" })).toBe(true);
  });

  it("prefers Groq when its key is set, otherwise the AI Gateway", () => {
    const groq = agentModel({ GROQ_API_KEY: "g" });
    expect(groq.name).toBe("groq/openai/gpt-oss-120b");
    expect(typeof groq.model).toBe("object");
    expect(groq.call).toMatchObject({ maxOutputTokens: 1200, providerOptions: { groq: { reasoningEffort: "low" } } });
    // The tool runs on a different Groq model, so the two never share a per-model rate limit.
    expect(toolModel({ GROQ_API_KEY: "g" }).name).toBe("groq/openai/gpt-oss-20b");
    expect(agentModel({ GROQ_API_KEY: "g", GROQ_MODEL: "a/b" }).name).toBe("groq/a/b");
    expect(toolModel({ GROQ_API_KEY: "g", GROQ_TOOL_MODEL: "c/d" }).name).toBe("groq/c/d");
    expect(agentModel({ AI_GATEWAY_API_KEY: "k" })).toEqual({ model: "anthropic/claude-haiku-5.5", name: "anthropic/claude-haiku-5.5", call: {} });
    expect(toolModel({ TOOL_MODEL: "x/y" })).toEqual({ model: "x/y", name: "x/y", call: {} });
  });
});
