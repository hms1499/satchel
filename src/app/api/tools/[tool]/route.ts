import { PAID_TOOLS, type ToolName } from "@/lib/tools";
import { providerKeys } from "@/lib/server/keys";
import { createChallenge, requestDigest, verifyPayment } from "@/lib/server/x402";
import { logEvent } from "@/lib/server/log";
import { paidResults } from "@/lib/server/result-cache";
import { runTool, ToolInputError, validateToolInput } from "@/lib/server/tool-impl";

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

  let params: URLSearchParams;
  if (request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    params = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
  } else {
    params = new URL(request.url).searchParams;
  }
  // Reject input that can only fail before asking for payment.
  try {
    validateToolInput(name, params);
  } catch (e) {
    if (e instanceof ToolInputError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  // The payment is bound to this exact request (see x402.ts): a paid header cannot buy a different call.
  const digest = requestDigest(name, params);

  const header = request.headers.get("x-payment");
  if (!header) {
    const payTo = providerKeys()[def.provider].address;
    const challenge = createChallenge(resource, payTo, def.price, digest);
    return Response.json(
      { error: "payment required", accepts: [{ scheme: "bch-sc402", ...challenge }] },
      { status: 402, headers: { "www-authenticate": 'BCH-SC402 realm="satchel"' } },
    );
  }

  const started = Date.now();
  const payment = await verifyPayment(header, resource, digest);
  if (!payment.ok) {
    logEvent("tool", { tool: name, status: 402, error: payment.error, ms: Date.now() - started });
    return Response.json({ error: payment.error }, { status: 402 });
  }

  // A replay of a paid request (retry) gets the stored response; the tool (and any LLM) runs once per payment.
  const cached = paidResults.get(payment.nonce);
  if (cached) {
    logEvent("tool", { tool: name, status: 200, txid: payment.txid, cached: true, ms: Date.now() - started });
    return Response.json(cached);
  }

  try {
    const result = await runTool(name, params);
    paidResults.set(payment.nonce, { result, paidWith: payment.txid }, payment.expires);
    logEvent("tool", { tool: name, status: 200, txid: payment.txid, ms: Date.now() - started });
    return Response.json({ result, paidWith: payment.txid });
  } catch (e) {
    const status = e instanceof ToolInputError ? 400 : 502;
    const error = e instanceof Error ? e.message : "tool failed";
    logEvent("tool", { tool: name, status, txid: payment.txid, error, ms: Date.now() - started });
    return Response.json({ error, paidWith: payment.txid }, { status });
  }
}

export const GET = handle;
export const POST = handle;
