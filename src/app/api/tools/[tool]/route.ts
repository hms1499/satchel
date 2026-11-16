import { PAID_TOOLS, type ToolName } from "@/lib/tools";
import { providerKeys } from "@/lib/server/keys";
import { createChallenge, verifyPayment } from "@/lib/server/x402";
import { runTool, ToolInputError } from "@/lib/server/tool-impl";

/**
 * Paid tool endpoint (HTTP 402 pay-per-call on Bitcoin Cash).
 * Without a valid `X-Payment` header it answers 402 with a signed payment challenge.
 */
async function handle(request: Request, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  if (!(tool in PAID_TOOLS)) return Response.json({ error: "unknown tool" }, { status: 404 });
  const name = tool as ToolName;
  const def = PAID_TOOLS[name];
  const resource = `/api/tools/${name}`;

  const header = request.headers.get("x-payment");
  if (!header) {
    const payTo = providerKeys()[def.provider].address;
    const challenge = createChallenge(resource, payTo, def.price);
    return Response.json(
      { error: "payment required", accepts: [{ scheme: "bch-sc402", ...challenge }] },
      { status: 402, headers: { "www-authenticate": 'BCH-SC402 realm="satchel"' } },
    );
  }

  const payment = await verifyPayment(header, resource);
  if (!payment.ok) return Response.json({ error: payment.error }, { status: 402 });

  let params: URLSearchParams;
  if (request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    params = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
  } else {
    params = new URL(request.url).searchParams;
  }

  try {
    const result = await runTool(name, params);
    return Response.json({ result, paidWith: payment.txid });
  } catch (e) {
    const status = e instanceof ToolInputError ? 400 : 502;
    return Response.json({ error: e instanceof Error ? e.message : "tool failed", paidWith: payment.txid }, { status });
  }
}

export const GET = handle;
export const POST = handle;
