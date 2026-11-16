import { PAID_TOOLS, type ToolName } from "../tools";
import { txUrl } from "../config";
import { payFromVault, type openDescriptor } from "./agent-wallet";
import { encodePaymentHeader, memoForChallenge, type Challenge } from "./x402";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "thought"; text: string }
  | { type: "invoice"; tool: ToolName; amount: string; payTo: string }
  | { type: "paid"; tool: ToolName; txid: string; url: string; amount: string; fee: string; spentInPeriod: string; remaining: string; balance: string }
  | { type: "rejected"; tool: ToolName | "attack"; reason: string; rule?: string; nodeError?: string; wouldSpend?: string }
  | { type: "tool-result"; tool: ToolName; summary: string }
  | { type: "final"; text: string }
  | { type: "error"; text: string };

export type Emit = (event: AgentEvent) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    emit({ type: "rejected", tool, reason: payment.reason, rule: payment.rule, nodeError: payment.nodeError, wouldSpend: payment.wouldSpend?.toString() });
    return { ok: false, error: `Payment refused: ${payment.reason}. The vault's spending cap for this period is exhausted or the payee is not allowed.` };
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

  // The server verifies the 0-conf tx via Electrum; allow a moment for propagation.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": encodePaymentHeader(challenge, payment.txid) },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, result: data.result };
    if (res.status === 402 && /not found/.test(data.error ?? "") && attempt < 4) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  }
  return { ok: false, error: "payment was not seen by the tool provider" };
}
