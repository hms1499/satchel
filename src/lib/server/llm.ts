/** LLM access goes through the Vercel AI Gateway (model strings like "anthropic/claude-haiku-5.5"). */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "anthropic/claude-haiku-5.5";

export function hasLlm(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}
