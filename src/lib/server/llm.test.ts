import { afterEach, describe, expect, it, vi } from "vitest";
import { agentModel, agentUsesLlm, budgetedFetch, LlmBudgetError, toolModel, toolUsesLlm } from "./llm";

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

describe("budgetedFetch", () => {
  const ok = () => new Response("{}", { status: 200 });
  const limited = (retryAfterS: number) => new Response("rate limited", { status: 429, headers: { "retry-after": String(retryAfterS) } });

  it("waits out a short 429 and retries", async () => {
    const base = vi.fn().mockResolvedValueOnce(limited(0.05)).mockResolvedValueOnce(ok());
    const f = budgetedFetch(() => Date.now() + 10_000, {}, base);
    expect((await f("https://x", { method: "POST", body: "{}" })).status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("returns a 429 at once when its retry-after does not fit the budget", async () => {
    const base = vi.fn().mockResolvedValue(limited(30));
    const t0 = Date.now();
    const res = await budgetedFetch(() => Date.now() + 60_000, {}, base)("https://x");
    expect(res.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("gives up after maxAttempts requests", async () => {
    const base = vi.fn().mockImplementation(async () => limited(0.01));
    const res = await budgetedFetch(() => Date.now() + 10_000, { maxAttempts: 2 }, base)("https://x");
    expect(res.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("aborts a hanging request at the deadline with LlmBudgetError", async () => {
    const hang = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const end = Date.now() + 1_300;
    const t0 = Date.now();
    await expect(budgetedFetch(() => end, {}, hang as typeof fetch)("https://x")).rejects.toBeInstanceOf(LlmBudgetError);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("refuses to start a request once the budget is used up", async () => {
    const base = vi.fn();
    await expect(budgetedFetch(() => Date.now() + 500, {}, base)("https://x")).rejects.toBeInstanceOf(LlmBudgetError);
    expect(base).not.toHaveBeenCalled();
  });

  it("passes a caller abort through unchanged", async () => {
    const ctrl = new AbortController();
    const hang = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("caller aborted"))));
    const p = budgetedFetch(() => Date.now() + 10_000, {}, hang as typeof fetch)("https://x", { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow("caller aborted");
  });
});
