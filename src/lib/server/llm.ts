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

/**
 * Groq when GROQ_API_KEY is set (free tier, no card needed), otherwise the Vercel AI Gateway with `gatewayModel`.
 * `name` is a readable label for logs and tool results.
 */
function pickModel(env: Env, groqModel: string, gatewayModel: string | undefined): ModelChoice {
  if (env.GROQ_API_KEY) {
    return { model: createGroq({ apiKey: env.GROQ_API_KEY })(groqModel), name: `groq/${groqModel}`, call: GROQ_CALL };
  }
  const id = gatewayModel || GATEWAY_DEFAULT_MODEL;
  return { model: id, name: id, call: {} };
}

/** Model for the hosted demo agent. */
export const agentModel = (env: Env = process.env) => pickModel(env, env.GROQ_MODEL || GROQ_AGENT_MODEL, env.AGENT_MODEL);
/** Model behind the paid `deep-analysis` tool. Independent of the demo agent's model. */
export const toolModel = (env: Env = process.env) => pickModel(env, env.GROQ_TOOL_MODEL || GROQ_TOOL_MODEL, env.TOOL_MODEL);

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
