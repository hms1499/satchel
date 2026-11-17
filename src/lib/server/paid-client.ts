import { PAID_TOOLS, type ToolName } from "../tools";
import { txUrl } from "../config";
import { payFromVault, type openDescriptor } from "./agent-wallet";
import { encodePaymentHeader, memoForChallenge, type Challenge } from "./x402";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "thought"; text: string }
  | { type: "invoice"; tool: ToolName; amount: string; payTo: string }
  | { type: "paid"; tool: ToolName; txid: string; url: string; amount: string; fee: string; spentInPeriod: string; remaining: string; balance: string }
  | { type: "rejected"; tool: ToolName | "attack"; reason: string; covenant: boolean; rule?: string; nodeError?: string; wouldSpend?: string }
  | { type: "tool-result"; tool: ToolName; summary: string }
  | { type: "final"; text: string }
  | { type: "error"; text: string };

export type Emit = (event: AgentEvent) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_MS = process.env.NODE_ENV === "test" ? [1, 1, 1, 1] : [800, 1600, 2400, 3200];

/**
 * Sends a paid request, retrying with the same payment header (idempotent: the payment is bound to this exact
 * request) while the provider has not seen the payment yet, on 5xx responses and on network errors.
 * Client errors (4xx other than "payment not found") are final.
 */
export async function retryPaidRequest(doFetch: () => Promise<Response>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  let lastError = "the tool provider did not answer";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let res: Response;
    try {
      res = await doFetch();
    } catch (e) {
      lastError = e instanceof Error ? e.message : "network error";
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (res.ok) return { ok: true, result: data.result };
    lastError = data.error ?? `HTTP ${res.status}`;
    const notSeenYet = res.status === 402 && /not found/.test(lastError);
    if (!notSeenYet && res.status < 500) return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError };
}

/** Calls a paid tool: on HTTP 402 it pays from the vault (with the challenge nonce as memo) and retries. */
export async function paidCall(
  origin: string,
  opened: ReturnType<typeof openDescriptor>,
  tool: ToolName,
  body: Record<string, string>,
  emit: Emit,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const url = `${origin}/api/tools/${tool}`;
  const first = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (first.status !== 402) {
    const data = await first.json().catch(() => ({}));
    return first.ok ? { ok: true, result: data.result } : { ok: false, error: data.error ?? `HTTP ${first.status}` };
  }
  const { accepts } = (await first.json()) as { accepts: Challenge[] };
  const challenge = accepts?.[0];
  if (!challenge || BigInt(challenge.amount) > PAID_TOOLS[tool].price * 2n) {
    return { ok: false, error: "unexpected payment challenge" };
  }
  emit({ type: "invoice", tool, amount: challenge.amount, payTo: challenge.payTo });

  const payment = await payFromVault(opened, challenge.payTo, BigInt(challenge.amount), memoForChallenge(challenge));
  if (!payment.ok) {
    emit({ type: "rejected", tool, reason: payment.reason, covenant: payment.covenant, rule: payment.rule, nodeError: payment.nodeError, wouldSpend: payment.wouldSpend?.toString() });
    return payment.covenant
      ? { ok: false, error: `Payment refused: ${payment.reason}. The vault's spending cap for this period is exhausted or the payee is not allowed.` }
      : { ok: false, error: `Payment failed: ${payment.reason}` };
  }
  emit({
    type: "paid",
    tool,
    txid: payment.txid,
    url: txUrl(payment.txid),
    amount: payment.amount.toString(),
    fee: payment.fee.toString(),
    spentInPeriod: payment.spentInPeriod.toString(),
    remaining: payment.remaining.toString(),
    balance: payment.balance.toString(),
  });

  // The provider verifies the 0-conf tx via Electrum (may lag a moment); the tool itself may fail transiently.
  const header = encodePaymentHeader(challenge, payment.txid);
  return retryPaidRequest(() =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-payment": header }, body: JSON.stringify(body) }),
  );
}
