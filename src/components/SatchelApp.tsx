"use client";

import { useEffect, useRef, useState } from "react";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";
import { NETWORK, txUrl } from "@/lib/config";
import { descriptorParams, type VaultDescriptor } from "@/lib/descriptor";
import { fetchConfig, fmtSats, loadDescriptor, saveDescriptor, shortAddress, shortHash, type AppConfig } from "@/lib/client/agent";
import { createVault, findOwnedVaults, ownerAccount, sumSats, walletFunds, withdrawVault, type CreateVaultInput } from "@/lib/client/wallet";
import { Banner } from "./Banner";
import { CreateVault } from "./CreateVault";
import { Dashboard } from "./Dashboard";
import { Landing } from "./Landing";
import { Button, Card, Logo } from "./ui";

type View = "landing" | "app";

export function SatchelApp() {
  const wc = useWizardConnect({ dappName: "Satchel", dappIcon: "https://satchel.vercel.app/icon.png" });
  const [view, setView] = useState<View>("landing");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [descriptor, setDescriptor] = useState<VaultDescriptor | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [closed, setClosed] = useState<{ txid: string; amount: bigint } | null>(null);
  const [owned, setOwned] = useState<{ descriptor: VaultDescriptor; balance: bigint }[]>([]);
  // `?agent=<pubkey>`: create the vault for the user's own agent (satchel-pay-mcp) instead of Satchel's hosted agent.
  const [externalAgentPk, setExternalAgentPk] = useState<string | null>(null);
  const [agentParamError, setAgentParamError] = useState<string | null>(null);

  useEffect(() => {
    fetchConfig().then(setConfig).catch(() => setConfig(null));
    const agentParam = new URLSearchParams(window.location.search).get("agent");
    if (agentParam !== null) {
      // Reading the URL after mount (window is unavailable during SSR).
      if (/^0[23][0-9a-f]{64}$/.test(agentParam)) setExternalAgentPk(agentParam); // eslint-disable-line react-hooks/set-state-in-effect
      else setAgentParamError("The agent key in this link is not a valid public key, so this vault would use Satchel's hosted agent instead. Run satchel_setup in your agent again to get a fresh link.");
      setView("app");
    }
    const stored = loadDescriptor();
    // Restoring persisted client state after mount (localStorage is unavailable during SSR).
    if (stored && stored.network === NETWORK) {
      setDescriptor(stored);
      setView("app");
    }
  }, []);

  const connected = wc.state === "connected" && wc.manager !== null;
  // After a page reload the hook restores the stored session: it stays "connecting" without a QR code until the
  // wallet answers, and connect() is ignored meanwhile. Show that state and offer a fresh pairing instead.
  const restoring = (wc.state === "connecting" && !wc.uri) || wc.state === "reconnecting";
  const pendingPair = useRef(false);
  const pairAgain = async () => {
    pendingPair.current = true;
    await wc.disconnect(); // drops the stored session; state returns to "idle"
  };
  const { state: wcState, connect: wcConnect } = wc;
  useEffect(() => {
    // connect() must run with the post-disconnect state, so it waits for the "idle" render.
    if (pendingPair.current && wcState === "idle") {
      pendingPair.current = false;
      wcConnect();
    }
  }, [wcState, wcConnect]);

  useEffect(() => {
    if (!connected || !wc.manager) return;
    let cancelled = false;
    walletFunds(wc.manager)
      .then((funds) => !cancelled && setWalletBalance(sumSats(funds)))
      .catch(() => !cancelled && setWalletBalance(null));
    return () => {
      cancelled = true;
    };
  }, [connected, wc.manager]);

  // No vault in this browser: look for open vaults this wallet owns on chain (genesis recovery memo).
  const knownPayees = config?.tools.map((t) => t.payTo);
  const payeesKey = knownPayees?.join(",");
  useEffect(() => {
    if (!connected || !wc.manager || !payeesKey || descriptor) return;
    let cancelled = false;
    findOwnedVaults(wc.manager, payeesKey.split(","))
      .then((list) => !cancelled && setOwned(list))
      .catch(() => !cancelled && setOwned([]));
    return () => {
      cancelled = true;
    };
  }, [connected, wc.manager, payeesKey, descriptor]);

  const openOwned = (d: VaultDescriptor) => {
    saveDescriptor(d);
    setDescriptor(d);
    setOwned([]);
    setClosed(null);
  };

  const owner = connected && wc.manager ? safeOwner(wc.manager) : null;

  const launch = () => {
    setView("app");
    if (!connected) wc.connect();
  };

  const onCreate = async (input: CreateVaultInput) => {
    if (!wc.manager) return;
    setCreateError(null);
    setBusyStep("Starting…");
    try {
      const d = await createVault(wc.manager, input, knownPayees ?? [], setBusyStep, externalAgentPk ?? undefined);
      saveDescriptor(d);
      setDescriptor(d);
      setClosed(null);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not create the vault");
    } finally {
      setBusyStep(null);
    }
  };

  const onWithdraw = async () => {
    if (!descriptor) return;
    if (!wc.manager || !connected) {
      if (restoring) {
        setWithdrawError("Still reconnecting to your wallet. Open it, or use “Pair again” at the top to scan a new QR code.");
        return;
      }
      setWithdrawError("Connect the owner wallet first.");
      wc.connect();
      return;
    }
    setWithdrawing(true);
    setWithdrawError(null);
    try {
      const result = await withdrawVault(wc.manager, descriptorParams(descriptor));
      saveDescriptor(null);
      setDescriptor(null);
      setClosed(result);
    } catch (e) {
      setWithdrawError(e instanceof Error ? e.message : "Withdrawal failed");
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Banner />
      <header className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <button className="flex cursor-pointer items-center gap-2.5" onClick={() => setView("landing")} aria-label="Satchel home">
          <Logo />
          <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">BCH {NETWORK}</span>
        </button>
        <div className="flex items-center gap-2.5">
          {connected ? (
            <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px]">
              <span className="size-2 rounded-full bg-brand-bright" />
              <span className="font-semibold">{wc.walletName ?? "Wallet"}</span>
              {owner && <span className="font-mono text-muted">{shortAddress(owner)}</span>}
              <button className="ml-1 cursor-pointer text-muted underline-offset-2 hover:underline" onClick={() => wc.disconnect()}>
                Disconnect
              </button>
            </div>
          ) : restoring ? (
            <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px]">
              <span className="size-2 animate-pulse rounded-full bg-[#e8862e]" />
              <span>Reconnecting{wc.walletName ? ` to ${wc.walletName}` : ""}… open your wallet</span>
              <button className="ml-1 cursor-pointer font-semibold text-brand underline-offset-2 hover:underline" onClick={pairAgain}>
                Pair again
              </button>
            </div>
          ) : (
            view === "app" && (
              <Button variant="dark" onClick={() => wc.connect()}>
                Connect wallet
              </Button>
            )
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1240px] px-4 pb-16 sm:px-6">
        {view === "app" && agentParamError && (
          <p role="alert" className="mt-4 rounded-[10px] bg-warn-soft px-3.5 py-2.5 text-sm text-warn-ink">
            {agentParamError}
          </p>
        )}
        {view === "landing" && <Landing onLaunch={launch} />}

        {view === "app" && closed && !descriptor && (
          <section className="flex justify-center py-12">
            <Card className="flex w-full max-w-[560px] flex-col gap-4 p-8">
              <span className="text-[13px] font-semibold text-brand">Vault closed</span>
              <h2 className="font-display text-[32px] font-bold tracking-tight">{fmtSats(closed.amount)} sats returned to your wallet</h2>
              <p className="text-body">
                The state NFT was burned and the agent key can no longer spend anything. Withdrawal transaction:{" "}
                <a className="font-mono text-brand underline" href={txUrl(closed.txid)} target="_blank" rel="noreferrer">
                  {shortHash(closed.txid)}
                </a>
              </p>
              <Button className="self-start" onClick={() => setClosed(null)}>
                Create another vault
              </Button>
            </Card>
          </section>
        )}

        {view === "app" && !closed && !descriptor && !connected && (
          <section className="flex justify-center py-12">
            <Card className="flex w-full max-w-[560px] flex-col gap-4 p-8">
              <span className="text-[13px] font-semibold text-brand">Step 1 of 3</span>
              <h2 className="font-display text-[32px] font-bold tracking-tight">Connect your wallet</h2>
              {externalAgentPk && (
                <p className="rounded-[10px] border border-brand bg-brand-soft px-3.5 py-2.5 text-sm text-[#1f3b30]">
                  You are creating a vault for your own agent (MCP):{" "}
                  <span className="font-mono">
                    {externalAgentPk.slice(0, 10)}…{externalAgentPk.slice(-6)}
                  </span>
                  .
                </p>
              )}
              <p className="text-body">
                Your wallet becomes the vault owner. Satchel never sees your keys: every transaction you make is signed in
                your wallet.
              </p>
              <ul className="list-disc pl-5 text-body">
                <li>Works with WizardConnect wallets such as Cashonize.</li>
                <li>You approve each transaction in your wallet: creating the vault (two approvals if your coins need preparing first) and withdrawing.</li>
              </ul>
              {wc.error && <p className="text-sm text-warn-ink">{wc.error}</p>}
              {restoring && (
                <p className="text-sm text-body">
                  Restoring your previous wallet session. Open your wallet app to finish, or pair again with a new QR code.
                </p>
              )}
              <Button className="min-h-12 self-start text-base" onClick={() => (restoring ? pairAgain() : wc.connect())}>
                {restoring ? "Pair again with a new QR code" : "Connect with WizardConnect"}
              </Button>
            </Card>
          </section>
        )}

        {view === "app" && !descriptor && connected && owned.length > 0 && (
          <section className="flex justify-center pt-6">
            <Card className="flex w-full max-w-[560px] flex-col gap-3 p-6">
              <span className="text-[13px] font-semibold text-brand">Found on the blockchain</span>
              <p className="text-body">
                Your wallet owns {owned.length === 1 ? "an open vault" : `${owned.length} open vaults`} that this browser doesn&apos;t
                remember. You can open {owned.length === 1 ? "it" : "them"} to check the balance and withdraw.
              </p>
              {owned.map(({ descriptor: d, balance }) => (
                <div key={d.genesisTxid} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3.5">
                  <span className="text-sm">
                    <span className="font-semibold">{fmtSats(balance)} sats</span>
                    <span className="text-muted"> · cap {fmtSats(d.params.capPerPeriod)} sats · created in </span>
                    <a className="font-mono text-brand underline" href={txUrl(d.genesisTxid!)} target="_blank" rel="noreferrer">
                      {shortHash(d.genesisTxid!)}
                    </a>
                  </span>
                  <Button variant="secondary" onClick={() => openOwned(d)}>
                    Open vault
                  </Button>
                </div>
              ))}
            </Card>
          </section>
        )}

        {view === "app" && !closed && !descriptor && connected && config && (
          <CreateVault
            tools={config.tools}
            sellers={config.sellers}
            walletBalance={walletBalance}
            externalAgentPk={externalAgentPk}
            busyStep={busyStep}
            error={createError}
            onCreate={onCreate}
          />
        )}

        {view === "app" && descriptor && config && (
          <Dashboard
            descriptor={descriptor}
            tools={config.tools}
            llm={config.llm}
            onWithdraw={onWithdraw}
            withdrawing={withdrawing}
            withdrawError={withdrawError}
          />
        )}
      </main>

      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog
          show={wc.state === "connecting"}
          onClose={() => wc.disconnect()}
          uri={wc.uri}
          qrUri={wc.qrUri}
          title="Connect to Satchel"
          theme={{ dialogBackground: "#ffffff", headerBackground: "#ffffff", titleColor: "#111614", subtitleColor: "#56605a", borderColor: "#dee2dc", uriRowBackground: "#f1f3ee", uriTextColor: "#3e4742", closeButtonColor: "#56605a", copyButtonColor: "#04704f" }}
        />
      )}
    </div>
  );
}

function safeOwner(manager: Parameters<typeof ownerAccount>[0]): string | null {
  try {
    return ownerAccount(manager).address;
  } catch {
    return null;
  }
}
