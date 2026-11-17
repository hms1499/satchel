import { AgentAuthError, openDescriptor } from "@/lib/server/agent-wallet";
import { runAgent } from "@/lib/server/agent-runner";
import { hasLlm } from "@/lib/server/llm";
import { logEvent } from "@/lib/server/log";
import type { AgentEvent } from "@/lib/server/paid-client";

export const maxDuration = 120;

/** Runs the research agent and streams its progress as NDJSON (one AgentEvent per line). */
export async function POST(request: Request) {
  let opened;
  let prompt: string;
  try {
    const body = await request.json();
    opened = openDescriptor(body.descriptor);
    prompt = String(body.prompt ?? "").trim().slice(0, 500);
    if (!prompt) throw new AgentAuthError("prompt is required");
  } catch (e) {
    const status = e instanceof AgentAuthError ? 400 : 500;
    return Response.json({ error: e instanceof Error ? e.message : "bad request" }, { status });
  }

  const origin = new URL(request.url).origin;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Run metrics for the logs (spec D5): payments made, covenant refusals, other failures, time to first payment.
      const started = Date.now();
      const stats = { paid: 0, refused: 0, failed: 0, msToFirstPayment: null as number | null, error: null as string | null };
      const emit = (event: AgentEvent) => {
        if (event.type === "paid") {
          stats.paid++;
          stats.msToFirstPayment ??= Date.now() - started;
        }
        if (event.type === "rejected") {
          if (event.covenant) stats.refused++;
          else stats.failed++;
        }
        if (event.type === "error") stats.error = event.text;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        emit({ type: "status", text: "Agent started" });
        await runAgent(origin, opened, prompt, emit);
      } catch (e) {
        emit({ type: "error", text: e instanceof Error ? e.message : "agent failed" });
      } finally {
        logEvent("agent_run", { vault: opened.contract.address.slice(-12), mode: hasLlm() ? "llm" : "scripted", ...stats, ms: Date.now() - started });
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
