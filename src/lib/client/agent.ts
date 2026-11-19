"use client";

import type { VaultDescriptor } from "../descriptor";
import type { SellerInfo } from "../allowlist";
import type { AgentEvent } from "../server/paid-client";
import type { VaultStatus } from "../server/agent-wallet";

export type { AgentEvent, SellerInfo, VaultStatus };

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  price: string;
  payTo: string;
}

export interface AppConfig {
  network: "mainnet" | "chipnet";
  llm: boolean;
  deepAnalysis: "live" | "demo"; // "demo": the deep-analysis tool returns a placeholder answer
  feePerCall: string; // estimated miner fee per paid call, sats (counts toward the cap)
  tools: ToolInfo[];
  sellers: SellerInfo[]; // suggested third-party sellers (SATCHEL_SELLERS)
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${url} failed (${res.status})`);
  return data as T;
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`/api/config failed (${res.status})${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

export const fetchStatus = (descriptor: VaultDescriptor) => postJson<VaultStatus>("/api/vault/status", { descriptor });

export interface AttackResult {
  kind: "overspend" | "attacker";
  rejected: boolean;
  reason: string;
  rule?: string;
  nodeError?: string;
}

export const runAttack = (descriptor: VaultDescriptor, kind: "overspend" | "attacker") =>
  postJson<AttackResult>("/api/agent/attack", { descriptor, kind });

/** Streams the agent's NDJSON events. Resolves when the run ends. */
export async function runAgent(descriptor: VaultDescriptor, prompt: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal) {
  const res = await fetch("/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ descriptor, prompt }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `agent failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as AgentEvent);
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AgentEvent);
}

export const fmtSats = (v: bigint | string | number) => BigInt(v).toLocaleString("en-US");
export const shortHash = (h: string, n = 6) => (h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-4)}` : h);
export const shortAddress = (a: string) => {
  const [, body = a] = a.split(":");
  return `${body.slice(0, 4)}…${body.slice(-4)}`;
};
