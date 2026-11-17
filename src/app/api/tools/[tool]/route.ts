import { PAID_TOOLS, type ToolName } from "@/lib/tools";
import { NETWORK } from "@/lib/config";
import { getProvider } from "@/lib/server/electrum";
import { providerKeys, providerSeed } from "@/lib/server/keys";
import { logEvent } from "@/lib/server/log";
import { paidResults } from "@/lib/server/result-cache";
import { runTool, validateToolInput } from "@/lib/server/tool-impl";
import { createPaywall, type PaidRoute } from "../../../../../provider-kit/src/index";

/**
 * Paid tool endpoint (HTTP 402 pay-per-call on Bitcoin Cash, bch-sc402), served by satchel-pay-server.
 * Without a valid `X-Payment` header it answers 402 with a signed payment challenge.
 */
let paywall: ReturnType<typeof createPaywall> | undefined;

// Created on the first request, not at import, so `next build` does not need PROVIDER_SEED.
function getPaywall() {
  paywall ??= createPaywall({
    network: NETWORK,
    secret: providerSeed(),
    getTransaction: (txid) => getProvider().getRawTransaction(txid),
    cache: paidResults,
    log: (e) => logEvent("tool", e),
  });
  return paywall;
}

function paidRoute(name: ToolName): PaidRoute {
  const def = PAID_TOOLS[name];
  return {
    resource: `/api/tools/${name}`,
    name,
    price: def.price,
    payTo: providerKeys()[def.provider].address,
    params: Object.keys(def.params),
    validate: (p) => validateToolInput(name, p),
    handler: (p) => runTool(name, p),
  };
}

async function handle(request: Request, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  if (!(tool in PAID_TOOLS)) return Response.json({ error: "unknown tool" }, { status: 404 });
  return getPaywall().handle(request, paidRoute(tool as ToolName));
}

export const GET = handle;
export const POST = handle;
