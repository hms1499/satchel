/** LLM access goes through the Vercel AI Gateway (model strings like "anthropic/claude-haiku-5.5"). */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "anthropic/claude-haiku-5.5";

/**
 * The LLM is opt-in: AGENT_MODE=llm plus gateway credentials (an API key, or the OIDC token Vercel injects into
 * every deployment). Without the explicit opt-in a Vercel deploy would silently switch to the LLM just because
 * VERCEL_OIDC_TOKEN exists. Default: the scripted research plan.
 */
export function hasLlm(): boolean {
  return process.env.AGENT_MODE === "llm" && Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}
