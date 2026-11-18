"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { txUrl } from "@/lib/config";
import type { VaultDescriptor } from "@/lib/descriptor";
import { encodeConnectCode } from "@/lib/connect-code";
import {
  fetchStatus,
  fmtSats,
  runAgent,
  runAttack,
  shortAddress,
  shortHash,
  type AgentEvent,
  type AttackResult,
  type ToolInfo,
  type VaultStatus,
} from "@/lib/client/agent";
import { Button, Card, CardTitle, Spinner } from "./ui";
import { WalletWait } from "./WalletWait";

interface LedgerRow {
  key: string;
  label: string;
  amount: string;
  fee: string;
  txid?: string;
  rejected?: boolean;
}

const DEFAULT_PROMPT = "Is BCH cheaper to use than ETH right now? Give me a short brief.";

export function Dashboard({
  descriptor,
  tools,
  llm,
  onWithdraw,
  withdrawing,
  withdrawError,
}: {
  descriptor: VaultDescriptor;
  tools: ToolInfo[];
  llm: boolean;
  onWithdraw: () => void;
  withdrawing: boolean;
  withdrawError: string | null;
}) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [attack, setAttack] = useState<AttackResult | null>(null);
  const [attacking, setAttacking] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>(() =>
    descriptor.genesisTxid ? [{ key: "genesis", label: "Vault created", amount: "deposit", fee: "—", txid: descriptor.genesisTxid }] : [],
  );
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchStatus(descriptor));
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "Could not load the vault");
    }
  }, [descriptor]);

  useEffect(() => {
    // Initial load plus a slow poll; payments also trigger a refresh.
    const first = setTimeout(refresh, 0);
    const id = setInterval(refresh, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [refresh]);

  const toolName = (n: string) => tools.find((t) => t.name === n)?.name ?? n;

  const onEvent = (e: AgentEvent) => {
    setEvents((prev) => [...prev, e]);
    if (e.type === "paid") {
      setLedger((l) => [{ key: e.txid, label: `Paid ${toolName(e.tool)}`, amount: `−${fmtSats(e.amount)}`, fee: `−${fmtSats(e.fee)}`, txid: e.txid }, ...l]);
      void refresh();
    }
    if (e.type === "rejected") {
      setLedger((l) => [{ key: `rej-${Date.now()}`, label: `Rejected: ${e.tool}`, amount: "0", fee: "—", rejected: true }, ...l]);
    }
  };

  const run = async () => {
    if (running || !prompt.trim()) return;
    setRunning(true);
    setEvents([{ type: "status", text: `You: ${prompt}` }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runAgent(descriptor, prompt.trim(), onEvent, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) onEvent({ type: "error", text: e instanceof Error ? e.message : "Agent failed" });
    } finally {
      setRunning(false);
      void refresh();
    }
  };

  const tryAttack = async (kind: "overspend" | "attacker") => {
    setAttacking(kind);
    setAttack(null);
    try {
      const r = await runAttack(descriptor, kind);
      setAttack(r);
      setLedger((l) => [{ key: `atk-${Date.now()}`, label: kind === "overspend" ? "Rejected: overspend" : "Rejected: pay attacker", amount: "0", fee: "—", rejected: true }, ...l]);
    } catch (e) {
      setAttack({ kind, rejected: false, reason: e instanceof Error ? e.message : "attack failed" });
    } finally {
      setAttacking(null);
    }
  };

  const cap = BigInt(descriptor.params.capPerPeriod);
  const remaining = status ? BigInt(status.remaining) : cap;
  const spent = cap - remaining;
  const pct = cap > 0n ? Math.min(100, Number((spent * 100n) / cap)) : 0;
  const blocksLeft = status ? Math.max(0, status.resetsAtHeight - status.tipHeight) : null;
  const periodNoun = descriptor.params.periodBlocks === "6" ? "hour" : descriptor.params.periodBlocks === "1008" ? "week" : descriptor.params.periodBlocks === "144" ? "day" : "period";
  // A vault recovered from chain has no agent access token (it is never published), so only the owner actions work.
  const agentLocked = !descriptor.token;
  // Tool payees show the tool name; sellers and custom payees their label; a vault recovered from chain has no labels.
  const payees = descriptor.params.allowlist.map((address) => ({
    address,
    name: tools.find((t) => t.payTo === address)?.name ?? descriptor.labels?.[address] ?? `Custom payee ${shortAddress(address)}`,
  }));

  return (
    <section className="flex flex-wrap items-start gap-6 py-6">
      <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-5">
        <Card className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Your vault</CardTitle>
            {status && <span className="font-mono text-xs text-muted">{shortAddress(status.address)}</span>}
          </div>
          <div className="flex flex-col">
            <span className="text-[13px] text-muted">Balance</span>
            <span className="font-display text-4xl font-bold tracking-tight">{status ? `${fmtSats(status.balance)} sats` : "…"}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[13px]">
              <span className="font-semibold">Spent this {periodNoun}</span>
              <span className="font-mono">
                {fmtSats(spent)} / {fmtSats(cap)} sats
              </span>
            </div>
            <div
              role="meter"
              aria-label="Budget used this period"
              aria-valuemin={0}
              aria-valuemax={Number(cap)}
              aria-valuenow={Number(spent)}
              className="h-3 overflow-hidden rounded-full bg-[#e9ece6]"
            >
              <div className={`h-full rounded-full transition-[width] ${pct >= 80 ? "bg-[#e8862e]" : "bg-brand-bright"}`} style={{ width: `${pct}%` }} />
            </div>
            {blocksLeft !== null && <span className="text-[13px] text-muted">Budget resets in about {fmtSats(blocksLeft)} blocks</span>}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-semibold">Allowlisted payees</span>
            <div className="flex flex-wrap gap-1.5">
              {payees.map((p) => (
                <span key={p.address} title={p.address} className="rounded-full border border-line bg-tint px-2.5 py-1 font-mono text-xs">
                  {p.name}
                </span>
              ))}
            </div>
          </div>
          {statusError && <p className="text-sm text-warn-ink">{statusError}</p>}
          {withdrawError && (
            <p role="alert" className="text-sm text-warn-ink">
              {withdrawError}
            </p>
          )}
          <Button variant="secondary" onClick={onWithdraw} disabled={withdrawing || running} className="border-ink">
            {withdrawing ? (
              <>
                <Spinner /> <span className="ml-2">Approve in your wallet…</span>
              </>
            ) : (
              "Withdraw everything"
            )}
          </Button>
          <WalletWait active={withdrawing} />
        </Card>

        {!agentLocked && (
        <Card className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1">
            <CardTitle>Try to break it</CardTitle>
            <p className="text-sm text-body">
              Simulate a compromised agent. These transactions are signed with the real agent key and broadcast; the network
              rejects them.
            </p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <Button variant="danger" onClick={() => tryAttack("overspend")} disabled={attacking !== null || running}>
              {attacking === "overspend" ? <Spinner /> : `Overspend ${fmtSats(cap + 1_000n)} sats`}
            </Button>
            <Button variant="danger" onClick={() => tryAttack("attacker")} disabled={attacking !== null || running}>
              {attacking === "attacker" ? <Spinner /> : "Pay an attacker address"}
            </Button>
          </div>
          {attack && (
            <div role="status" className="flex flex-col gap-1.5 rounded-xl border border-warn-line bg-warn-soft p-3.5 text-warn-deep">
              <span className="font-semibold text-warn-ink">{attack.rejected ? "Rejected by the network" : "Could not run the test"}</span>
              {attack.nodeError && <span className="break-all font-mono text-xs">{attack.nodeError}</span>}
              {attack.rule && (
                <span className="text-[13px]">
                  Failing rule: <span className="font-mono">{attack.rule}</span>
                </span>
              )}
              {!attack.rejected && <span className="text-[13px]">{attack.reason}</span>}
              {attack.rejected && <span className="text-[13px]">Vault balance unchanged.</span>}
            </div>
          )}
        </Card>
        )}
      </div>

      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
        {descriptor.external ? (
          <ConnectAgentCard descriptor={descriptor} />
        ) : agentLocked ? (
          <Card className="flex flex-col gap-3">
            <CardTitle>Recovered from the blockchain</CardTitle>
            <p className="text-sm text-body">
              This browser had lost the vault, so Satchel rebuilt it from your wallet&apos;s on-chain history. Your funds are
              safe and you can withdraw them now. The agent&apos;s access key is never written on-chain, so the agent can&apos;t
              use this vault any more: withdraw, then create a new vault to keep going.
            </p>
          </Card>
        ) : (
        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Research agent</CardTitle>
            <span className="text-[13px] text-muted">{llm ? "Pays for tools from this vault" : "Demo mode: fixed research plan (no LLM key)"}</span>
          </div>
          <div className="flex flex-wrap items-end gap-2.5">
            <label className="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5 text-[13px] font-semibold">
              Task for the agent
              <input
                className="min-h-11 rounded-[10px] border border-line-strong p-3 text-[15px] font-normal"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && run()}
                maxLength={500}
              />
            </label>
            <Button onClick={run} disabled={running}>
              {running ? (
                <>
                  <Spinner /> <span className="ml-2">Agent working…</span>
                </>
              ) : (
                "Run agent"
              )}
            </Button>
          </div>
          <div className="flex min-h-[120px] flex-col gap-2.5" aria-live="polite">
            {events.length === 0 && (
              <div className="rounded-xl border border-dashed border-line-strong p-5 text-sm text-muted">
                Run the agent to watch it pay for tools. Each paid call is a real BCH transaction from the vault.
              </div>
            )}
            {events.map((e, i) => (
              <EventView key={i} e={e} />
            ))}
          </div>
        </Card>
        )}

        <Card className="flex flex-col gap-3">
          <CardTitle>On-chain activity</CardTitle>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-[0.04em] text-muted">
                  <th className="py-2 font-semibold">Event</th>
                  <th className="py-2 font-semibold">Amount</th>
                  <th className="py-2 font-semibold">Fee</th>
                  <th className="py-2 font-semibold">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.key} className="border-b border-[#eef0ec]">
                    <td className={`py-2.5 ${row.rejected ? "font-semibold text-warn-ink" : ""}`}>{row.label}</td>
                    <td className="py-2.5 font-mono">{row.amount}</td>
                    <td className="py-2.5 font-mono text-muted">{row.fee}</td>
                    <td className="py-2.5 font-mono text-[13px]">
                      {row.txid ? (
                        <a className="text-brand underline-offset-2 hover:underline" href={txUrl(row.txid)} target="_blank" rel="noreferrer">
                          {shortHash(row.txid)}
                        </a>
                      ) : (
                        <span className="text-muted">not mined</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </section>
  );
}

/** For a vault whose agent is the user's own (satchel-pay-mcp): the code the agent needs to use this vault. */
function ConnectAgentCard({ descriptor }: { descriptor: VaultDescriptor }) {
  const code = encodeConnectCode({
    v: 1,
    network: descriptor.network,
    params: descriptor.params,
    genesisTxid: descriptor.genesisTxid,
    labels: descriptor.labels,
    sellers: descriptor.sellers,
  });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Connect your agent</CardTitle>
      <p className="text-sm text-body">
        This vault&apos;s agent runs in your own MCP client, and its key never leaves your machine. Paste this code into
        your agent&apos;s chat; it calls <span className="font-mono">satchel_connect</span>. The code holds no secret.
      </p>
      <textarea
        readOnly
        value={code}
        aria-label="Connect code"
        className="min-h-24 break-all rounded-[10px] border border-line-strong bg-tint p-3 font-mono text-xs"
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button variant="secondary" className="self-start" onClick={copy}>
        {copied ? "Copied" : "Copy connect code"}
      </Button>
    </Card>
  );
}

function EventView({ e }: { e: AgentEvent }) {
  switch (e.type) {
    case "status":
      return <div className="self-end max-w-[80%] rounded-[14px_14px_4px_14px] bg-ink px-3.5 py-2.5 text-sm text-white">{e.text.replace(/^You: /, "")}</div>;
    case "thought":
    case "final":
      return <div className="max-w-[88%] whitespace-pre-line rounded-[14px_14px_14px_4px] bg-tint px-3.5 py-2.5 text-sm">{e.text}</div>;
    case "invoice":
      return (
        <div className="flex flex-col gap-1 rounded-xl border border-info-line bg-info-soft px-3.5 py-2.5 text-[13px]">
          <span className="font-mono font-medium text-info-ink">POST /api/tools/{e.tool} → 402 Payment Required</span>
          <span className="text-[#2a3550]">Price {fmtSats(e.amount)} sats. Paying from the vault…</span>
        </div>
      );
    case "paid":
      return (
        <div className="flex flex-col gap-1 rounded-xl border border-info-line bg-info-soft px-3.5 py-2.5 text-[13px]">
          <span className="font-mono font-medium text-info-ink">
            Paid {fmtSats(e.amount)} sats (+{fmtSats(e.fee)} fee) ·{" "}
            <a className="underline" href={e.url} target="_blank" rel="noreferrer">
              tx {shortHash(e.txid)}
            </a>
          </span>
          <span className="text-[#2a3550]">Budget left this period: {fmtSats(e.remaining)} sats</span>
        </div>
      );
    case "tool-result":
      return <div className="rounded-xl border border-line px-3.5 py-2.5 text-[13px] text-body">↳ {e.summary}</div>;
    case "rejected":
      return (
        <div className="flex flex-col gap-1 rounded-xl border border-warn-line bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn-deep">
          <span className="font-semibold text-warn-ink">Covenant rejected the payment for {e.tool}</span>
          {e.wouldSpend && <span>This payment would bring the period to {fmtSats(e.wouldSpend)} sats, above the cap.</span>}
          {e.rule && (
            <span>
              Failing rule: <span className="font-mono">{e.rule}</span>
            </span>
          )}
          {e.nodeError && <span className="break-all font-mono text-xs">{e.nodeError}</span>}
        </div>
      );
    case "error":
      return <div className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm text-warn-ink">{e.text}</div>;
  }
}
