"use client";

import { useState } from "react";
import { DEFAULTS, NETWORK } from "@/lib/config";
import { buildAllowlist } from "@/lib/allowlist";
import { defaultAllowed, estimateFeePerCall, type ToolName } from "@/lib/tools";
import { fmtSats, type SellerInfo, type ToolInfo } from "@/lib/client/agent";
import { awaitsWallet, type CreateVaultInput } from "@/lib/client/wallet";
import { CustomPayees, type PayeeRow } from "./CustomPayees";
import { Button, Card, Spinner } from "./ui";
import { WalletWait } from "./WalletWait";

const PERIODS = [
  { value: "6", label: "Per hour (6 blocks)", noun: "hour" },
  { value: "144", label: "Per day (144 blocks)", noun: "day" },
  { value: "1008", label: "Per week (1,008 blocks)", noun: "week" },
];

export function CreateVault({
  tools,
  sellers,
  walletBalance,
  externalAgentPk,
  busyStep,
  error,
  onCreate,
}: {
  tools: ToolInfo[];
  sellers: SellerInfo[];
  walletBalance: bigint | null;
  externalAgentPk: string | null;
  busyStep: string | null;
  error: string | null;
  onCreate: (input: CreateVaultInput) => void;
}) {
  const [deposit, setDeposit] = useState(DEFAULTS.deposit.toString());
  const [cap, setCap] = useState(DEFAULTS.capPerPeriod.toString());
  const [period, setPeriod] = useState(DEFAULTS.periodBlocks.toString());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [pickedSellers, setPickedSellers] = useState<Record<number, boolean>>({}); // off by default
  const [customRows, setCustomRows] = useState<PayeeRow[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const isOn = (name: string) => selected[name] ?? defaultAllowed(name as ToolName, Boolean(externalAgentPk));
  const allowed = tools.filter((t) => isOn(t.name));
  // Sellers and custom payees can only be paid by the user's own (MCP) agent, so they exist only on external vaults.
  const external = Boolean(externalAgentPk);
  const chosenSellers = external ? sellers.filter((_, i) => pickedSellers[i]) : [];
  const chosenCustom = external ? customRows : [];
  const payeeNames = [
    ...allowed.map((t) => t.name),
    ...chosenSellers.map((s) => s.name),
    ...chosenCustom.filter((r) => r.address.trim()).map((r) => r.label.trim() || "a custom payee"),
  ];
  const fee = estimateFeePerCall(payeeNames.length || 1).toString();
  const noun = PERIODS.find((p) => p.value === period)?.noun ?? "period";
  const busy = busyStep !== null;

  const submit = () => {
    const d = BigInt(deposit || "0");
    const c = BigInt(cap || "0");
    const built = buildAllowlist({
      tools: allowed.map((t) => t.payTo),
      sellers: chosenSellers,
      custom: chosenCustom,
      network: NETWORK,
      knownPayees: tools.map((t) => t.payTo),
    });
    if (!built.ok) return setFormError(built.error);
    if (d < 5_000n) return setFormError("Deposit at least 5,000 sats.");
    if (c < 2_000n) return setFormError("Set a cap of at least 2,000 sats.");
    setFormError(null);
    onCreate({
      deposit: d,
      capPerPeriod: c,
      periodBlocks: BigInt(period),
      allowlist: built.allowlist,
      labels: built.labels,
      sellers: built.sellers,
    });
  };

  const field = "min-h-11 rounded-[10px] border border-line-strong bg-surface p-3 font-mono text-[15px] font-normal";

  return (
    <section className="flex flex-wrap gap-6 py-6">
      <Card className="flex min-w-0 flex-[999_1_560px] flex-col gap-6 p-7">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-brand">Step 2 of 3</span>
          <h2 className="font-display text-[32px] font-bold tracking-tight">Create a vault for your agent</h2>
          {externalAgentPk && (
            <div className="rounded-[10px] border border-brand bg-brand-soft px-3.5 py-2.5 text-sm text-[#1f3b30]">
              Creating a vault for your own agent (MCP):{" "}
              <span className="font-mono">
                {externalAgentPk.slice(0, 10)}…{externalAgentPk.slice(-6)}
              </span>
              . Satchel never sees its private key.
            </div>
          )}
          {walletBalance !== null && (
            <span className="text-sm text-muted">Wallet balance: {fmtSats(walletBalance)} sats</span>
          )}
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            Deposit (sats)
            <input className={field} type="number" min={5000} step={1000} value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            Spending cap (sats)
            <input className={field} type="number" min={2000} step={500} value={cap} onChange={(e) => setCap(e.target.value)} />
            <span className="text-[13px] font-normal text-muted">Fees count toward the cap</span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            Period
            <select className={`${field} font-sans`} value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="text-[13px] font-normal text-muted">Measured in block height</span>
          </label>
        </div>
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-sm font-semibold">Paid APIs the agent may pay (allowlist)</legend>
          {tools.map((t) => (
            <label key={t.name} className="flex min-h-11 cursor-pointer items-center gap-3.5 rounded-xl border border-line px-3.5 py-3">
              <input
                type="checkbox"
                className="size-5 accent-brand"
                checked={isOn(t.name)}
                onChange={() => setSelected((s) => ({ ...s, [t.name]: !isOn(t.name) }))}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-mono text-sm font-semibold">{t.name}</span>
                <span className="text-[13px] text-muted">{t.description}</span>
              </span>
              <span className="flex flex-col items-end whitespace-nowrap font-mono text-[13px] text-body">
                <span>{fmtSats(t.price)} sats / call</span>
                <span className="text-xs text-muted">+ ~{fmtSats(fee)} network fee</span>
              </span>
            </label>
          ))}
        </fieldset>
        {external && sellers.length > 0 && (
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-1 text-sm font-semibold">Suggested sellers</legend>
            <p className="text-[13px] text-muted">Other APIs that accept payment from a Satchel vault. Tick one to let your agent pay it.</p>
            {sellers.map((s, i) => (
              <label key={`${s.origin}-${s.payTo}`} className="flex min-h-11 cursor-pointer items-center gap-3.5 rounded-xl border border-line px-3.5 py-3">
                <input
                  type="checkbox"
                  className="size-5 accent-brand"
                  checked={pickedSellers[i] ?? false}
                  onChange={() => setPickedSellers((p) => ({ ...p, [i]: !p[i] }))}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-semibold">{s.name}</span>
                  {s.description && <span className="text-[13px] text-muted">{s.description}</span>}
                  <span className="break-all font-mono text-xs text-muted">{s.origin}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {external && <CustomPayees rows={customRows} onChange={setCustomRows} field={field} />}
        <p className="text-[13px] text-muted">At most 8 payees in total.</p>
        {(formError || error) && (
          <div role="alert" className="rounded-[10px] bg-warn-soft px-3.5 py-2.5 text-sm text-warn-ink">
            {formError || error}
          </div>
        )}
        <Button onClick={submit} disabled={busy} className="min-h-12 self-start text-base">
          {busy ? (
            <>
              <Spinner /> <span className="ml-2">{busyStep}</span>
            </>
          ) : (
            "Create vault and deposit"
          )}
        </Button>
        <WalletWait key={busyStep ?? ""} active={awaitsWallet(busyStep)} />
      </Card>
      <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
        <div className="flex flex-col gap-2.5 rounded-[20px] bg-brand-soft p-6 text-[#1f3b30]">
          <span className="font-display text-[19px] font-semibold text-ink">What the covenant will enforce</span>
          <span>
            Your agent can spend at most {fmtSats(cap || "0")} sats per {noun} (fees included), and only to{" "}
            {payeeNames.length ? payeeNames.join(", ") : "nobody yet"}.
          </span>
          <span>
            Each paid call also pays a Bitcoin Cash network fee of about {fmtSats(fee)} sats, which counts toward
            the cap.
          </span>
          <span>You can withdraw everything at any time. Only your wallet can do that.</span>
        </div>
        <Card className="flex flex-col gap-2 text-sm text-body">
          <span className="font-semibold text-ink">Under the hood</span>
          <span>Contract: Satchel.cash (CashScript), P2SH32</span>
          <span>State: mutable CashTokens NFT (period start + spent)</span>
          <span>Agent key: fresh for this vault, held by the Satchel server</span>
        </Card>
      </aside>
    </section>
  );
}
