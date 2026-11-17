/** LLM access goes through the Vercel AI Gateway (model strings like "anthropic/claude-haiku-5.5"). */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "anthropic/claude-haiku-5.5";
/** Model behind the paid `deep-analysis` tool. Independent of the demo agent's model. */
export const TOOL_MODEL = process.env.TOOL_MODEL ?? "anthropic/claude-haiku-5.5";

type Env = Record<string, string | undefined>;

const hasGatewayCredentials = (env: Env) => Boolean(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN);

/**
 * The demo agent's LLM is opt-in: AGENT_MODE=llm plus gateway credentials (an API key, or the OIDC token Vercel
 * injects into every deployment). Without the explicit opt-in a Vercel deploy would silently switch to the LLM just
 * because VERCEL_OIDC_TOKEN exists. Default: the scripted research plan.
 */
export function agentUsesLlm(env: Env = process.env): boolean {
  return env.AGENT_MODE === "llm" && hasGatewayCredentials(env);
}

/** The paid `deep-analysis` tool calls a real model only with TOOL_LLM=on plus gateway credentials. */
export function toolUsesLlm(env: Env = process.env): boolean {
  return env.TOOL_LLM === "on" && hasGatewayCredentials(env);
}
