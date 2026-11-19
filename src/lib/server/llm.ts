import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

type Env = Record<string, string | undefined>;

/**
 * Groq free tier (no card): 1K requests/day and 8K tokens/minute *per model*, and each request reserves its max output
 * tokens against that minute. So the agent and the `deep-analysis` tool use different models (separate buckets),
 * output is capped and reasoning effort is low. Override with GROQ_MODEL / GROQ_TOOL_MODEL.
 */
const GROQ_AGENT_MODEL = "openai/gpt-oss-120b";
const GROQ_TOOL_MODEL = "openai/gpt-oss-20b";
const GROQ_CALL = { maxOutputTokens: 1200, providerOptions: { groq: { reasoningEffort: "low" as const } } };
/** Default AI Gateway model (model strings like "anthropic/claude-haiku-5.5"). */
const GATEWAY_DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

/** `call` holds per-call settings to spread into generateText / ToolLoopAgent. */
export type ModelChoice = { model: LanguageModel; name: string; call: Partial<typeof GROQ_CALL> };

/** Epoch ms after which no new model request may start (re-read on every request, so it can move). */
export type Deadline = () => number;

export class LlmBudgetError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryWaitMs(headers: Headers, attempt: number): number {
  const ms = Number(headers.get("retry-after-ms"));
  if (ms > 0) return ms;
  const s = Number(headers.get("retry-after"));
  if (s > 0) return s * 1000;
  return 2000 * 2 ** attempt;
}

/**
 * A fetch for the model provider that can never outlive `deadline`: each request times out at
 * min(requestMs, time left), and a 429 / 5xx is retried here (at most `maxAttempts` requests) only when the
 * server's retry-after fits in both `maxWaitMs` and the time left. Otherwise the error response is returned at once,
 * so the caller (with SDK retries off) fails fast and falls back instead of hanging past the function's maxDuration.
 * Only model HTTP calls go through this; paid tool executions are never cut off mid-payment.
 */
export function budgetedFetch(
  deadline: Deadline,
  { requestMs = 20_000, maxWaitMs = 12_000, maxAttempts = 3 } = {},
  base: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const left = deadline() - Date.now();
      if (left < 1000) throw new LlmBudgetError("the language model's time budget for this run is used up");
      const timeoutMs = Math.min(requestMs, left);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await base(input, { ...init, signal });
      } catch (e) {
        if (timeout.aborted && !init?.signal?.aborted) {
          throw new LlmBudgetError(`the language model did not answer within ${Math.round(timeoutMs / 1000)} s`);
        }
        throw e;
      }
      if ((res.status === 429 || res.status >= 500) && attempt + 1 < maxAttempts) {
        const wait = retryWaitMs(res.headers, attempt);
        if (wait <= maxWaitMs && Date.now() + wait < deadline() - 2000) {
          await res.body?.cancel();
          await sleep(wait);
          continue;
        }
      }
      return res;
    }
  };
}

/**
 * Groq when GROQ_API_KEY is set (free tier, no card needed), otherwise the Vercel AI Gateway with `gatewayModel`.
 * `name` is a readable label for logs and tool results. With a `deadline`, Groq requests go through `budgetedFetch`.
 */
function pickModel(env: Env, groqModel: string, gatewayModel: string | undefined, deadline?: Deadline): ModelChoice {
  if (env.GROQ_API_KEY) {
    const fetch = deadline ? budgetedFetch(deadline) : undefined;
    return { model: createGroq({ apiKey: env.GROQ_API_KEY, fetch })(groqModel), name: `groq/${groqModel}`, call: GROQ_CALL };
  }
  const id = gatewayModel || GATEWAY_DEFAULT_MODEL;
  return { model: id, name: id, call: {} };
}

/** Model for the hosted demo agent. */
export const agentModel = (env: Env = process.env, deadline?: Deadline) =>
  pickModel(env, env.GROQ_MODEL || GROQ_AGENT_MODEL, env.AGENT_MODEL, deadline);
/** Model behind the paid `deep-analysis` tool. Independent of the demo agent's model. */
export const toolModel = (env: Env = process.env, deadline?: Deadline) =>
  pickModel(env, env.GROQ_TOOL_MODEL || GROQ_TOOL_MODEL, env.TOOL_MODEL, deadline);

const hasLlmCredentials = (env: Env) => Boolean(env.GROQ_API_KEY || env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN);

/**
 * The demo agent's LLM is opt-in: AGENT_MODE=llm plus credentials (a Groq key, an AI Gateway key, or the OIDC token
 * Vercel injects into every deployment). Without the explicit opt-in a Vercel deploy would silently switch to the LLM
 * just because VERCEL_OIDC_TOKEN exists. Default: the scripted research plan.
 */
export function agentUsesLlm(env: Env = process.env): boolean {
  return env.AGENT_MODE === "llm" && hasLlmCredentials(env);
}

/** The paid `deep-analysis` tool calls a real model only with TOOL_LLM=on plus credentials. */
export function toolUsesLlm(env: Env = process.env): boolean {
  return env.TOOL_LLM === "on" && hasLlmCredentials(env);
}
