"use client";

import { txUrl } from "@/lib/config";
import { fmtSats, shortHash } from "@/lib/client/agent";
import type { OpenVault } from "@/lib/client/vault-routing";
import { Button, Card, Spinner } from "./ui";

const periodNoun = (blocks: string) => (blocks === "6" ? "hour" : blocks === "144" ? "day" : blocks === "1008" ? "week" : `${blocks} blocks`);

/** "Your vaults": the open vaults of the connected wallet, plus the scan's progress and failure states. */
export function VaultList({
  state,
  vaults,
  onOpen,
  onNew,
  onRetry,
}: {
  state: "scanning" | "failed" | "list";
  vaults: OpenVault[];
  onOpen: (v: OpenVault) => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  return (
    <section className="flex justify-center py-8">
      <Card className="flex w-full max-w-[640px] flex-col gap-4 p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-[28px] font-bold tracking-tight">Your vaults</h2>
          {state === "list" && (
            <Button variant="secondary" onClick={onNew}>
              + New vault
            </Button>
          )}
        </div>

        {state === "scanning" && (
          <p className="flex items-center gap-2.5 text-body" role="status">
            <Spinner /> Looking for your vaults in your wallet&apos;s history…
          </p>
        )}

        {state === "failed" && (
          <div className="flex flex-col gap-3" role="alert">
            <p className="text-body">Couldn&apos;t search your wallet for vaults. Your funds are safe; this is only the lookup.</p>
            <div className="flex flex-wrap gap-2.5">
              <Button onClick={onRetry}>Retry</Button>
              <Button variant="secondary" onClick={onNew}>
                Create a new vault anyway
              </Button>
            </div>
          </div>
        )}

        {state === "list" &&
          vaults.map((v) => (
            <div key={v.descriptor.params.agentPk + v.descriptor.params.capPerPeriod} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3.5">
              <span className="flex min-w-0 flex-col gap-1 text-sm">
                <span>
                  <span className="text-base font-semibold">{fmtSats(v.balance)} sats</span>
                  {v.withdrawOnly && <span className="ml-2 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-semibold text-warn-ink">Withdraw only</span>}
                </span>
                <span className="text-muted">
                  cap {fmtSats(v.descriptor.params.capPerPeriod)} sats per {periodNoun(v.descriptor.params.periodBlocks)}
                  {v.descriptor.genesisTxid && (
                    <>
                      {" · created "}
                      <a className="font-mono text-brand underline" href={txUrl(v.descriptor.genesisTxid)} target="_blank" rel="noreferrer">
                        {shortHash(v.descriptor.genesisTxid)}
                      </a>
                    </>
                  )}
                </span>
              </span>
              <Button variant="secondary" onClick={() => onOpen(v)}>
                Open
              </Button>
            </div>
          ))}
      </Card>
    </section>
  );
}
