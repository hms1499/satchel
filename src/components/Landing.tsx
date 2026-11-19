import { LINKS, MAINNET_PROOF, proofTxUrl } from "@/lib/proof";
import { Button } from "./ui";

const RULES = [
  { title: "A cap in any window", body: "The agent can spend at most X sats in any N-block window, fees included; a new period starts only N blocks after the last payment. The counter lives on-chain in a CashTokens NFT." },
  { title: "Allowlisted payees only", body: "Payments can only go to the API providers you approved. Any other address is rejected by every node." },
  { title: "You can always pull out", body: "Your wallet key can withdraw everything at any time. The agent key never can." },
];

export function Landing({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="flex flex-col gap-12 pb-16">
      <section className="flex flex-wrap items-center gap-10 pt-8">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-5">
          <span className="text-[13px] font-semibold uppercase tracking-[0.06em] text-brand">Pocket money for AI agents</span>
          <h1 className="font-display text-[clamp(38px,6vw,56px)] font-bold leading-[1.04] tracking-[-0.025em]">
            Give your agent a budget, not your keys.
          </h1>
          <p className="max-w-[560px] text-lg text-body">
            Satchel lets an AI agent pay for APIs on its own, while Bitcoin Cash consensus enforces a spending cap and a
            recipient allowlist. Even if the agent is hacked or prompt-injected, it cannot spend more than you allowed.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={onLaunch} className="min-h-12 text-base">
              Launch app
            </Button>
            <a
              href="#how"
              className="inline-flex min-h-12 items-center rounded-xl border border-line-strong px-5 font-semibold text-ink hover:bg-tint"
            >
              How it works
            </a>
          </div>
          <p className="text-[15px] text-muted">
            <a href="#proof" className="font-semibold text-brand hover:underline">
              Verified on mainnet ↓
            </a>
            <span className="px-2">·</span>
            <a href="#developers" className="font-semibold text-brand hover:underline">
              Use it from your own agent ↓
            </a>
          </p>
        </div>
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-3 rounded-[20px] border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(17,22,20,0.04),0_12px_32px_rgba(17,22,20,0.06)]">
          <span className="text-[13px] font-semibold text-muted">Why this matters</span>
          <p className="text-body">
            Agents with ordinary wallets are one bad prompt away from draining them. Software spending limits live in the
            same place as the bug. Satchel moves the limit into the coin itself: the network refuses any transaction that
            breaks it.
          </p>
          <div className="rounded-xl bg-ink p-4 font-mono text-[13px] leading-relaxed text-[#e8ece6]">
            <div className="text-[#8a958e]">{"// what a compromised agent gets"}</div>
            <div className="text-[#f5b97a]">{"→ mandatory-script-verify-flag-failed"}</div>
            <div className="text-[#7fe3c2]">{"→ vault balance unchanged"}</div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
        {RULES.map((r) => (
          <div key={r.title} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5">
            <h2 className="font-display text-[19px] font-semibold">{r.title}</h2>
            <p className="text-body">{r.body}</p>
          </div>
        ))}
      </section>

      <section id="how" className="flex flex-wrap gap-8">
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-4">
          <h2 className="font-display text-[32px] font-bold tracking-tight">How it works</h2>
          <ol className="flex list-decimal flex-col gap-2.5 pl-5 text-body">
            <li>
              <strong className="text-ink">Connect</strong> your BCH wallet with WizardConnect.
            </li>
            <li>
              <strong className="text-ink">Create a vault</strong>: set a deposit, a cap per period and which paid APIs the
              agent may pay.
            </li>
            <li>
              <strong className="text-ink">Let the agent work.</strong> When an API answers 402 Payment Required, the agent
              pays from the vault and retries.
            </li>
            <li>
              <strong className="text-ink">Stay in control.</strong> Overspending fails at consensus level, and you withdraw
              whenever you want.
            </li>
          </ol>
        </div>
        <pre className="min-w-0 flex-[1_1_420px] overflow-x-auto rounded-2xl bg-ink p-5 font-mono text-[13px] leading-[1.7] text-[#e8ece6]">
          <span className="text-[#8a958e]">{"// pay-per-call on Bitcoin Cash (HTTP 402)\n"}</span>
          {"POST /api/tools/crypto-price\n"}
          <span className="text-[#f5b97a]">{"← 402 { payTo, amount: 1000, nonce }\n"}</span>
          <span className="text-[#8a958e]">{"// agent pays from the vault, memo = SC402 + nonce\n"}</span>
          {"POST /api/tools/crypto-price  X-Payment: <txid>\n"}
          <span className="text-[#7fe3c2]">{"← 200 { price, change24h, marketCap }"}</span>
        </pre>
      </section>

      <section id="proof" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[32px] font-bold tracking-tight">Verified on BCH mainnet</h2>
          <p className="max-w-[680px] text-body">
            One end-to-end run with real coins: a developer&apos;s own agent, through the Satchel MCP server, paying Satchel
            and an independent seller from one vault. Every step is a public transaction.
          </p>
        </div>
        <ol className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
          {MAINNET_PROOF.map((s, i) => (
            <li key={s.label} className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-line bg-surface p-4">
              <span className="text-[13px] font-semibold text-muted">
                {i + 1}. {s.label}
              </span>
              <p className="text-[15px] text-body">{s.detail}</p>
              {s.txid ? (
                <a
                  href={proofTxUrl(s.txid)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-auto truncate font-mono text-[13px] text-brand underline-offset-2 hover:underline"
                >
                  tx {s.txid.slice(0, 10)}…{s.txid.slice(-6)} ↗
                </a>
              ) : (
                <span className="mt-auto font-mono text-[13px] text-warn">rejected by consensus, no tx</span>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section id="developers" className="flex flex-col gap-4">
        <h2 className="font-display text-[32px] font-bold tracking-tight">For developers</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
          <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
            <h3 className="font-display text-[19px] font-semibold">Give your own agent a Satchel</h3>
            <p className="text-body">
              An MCP server for Claude, Cursor, VS Code and other MCP clients. The agent key stays on your machine; the
              covenant enforces the cap and the allowlist.
            </p>
            <code className="block overflow-x-auto whitespace-nowrap rounded-xl bg-ink px-4 py-3 font-mono text-[13px] text-[#e8ece6]">
              claude mcp add satchel -- npx -y satchel-pay-mcp@0.1.0
            </code>
            <a href={LINKS.mcpNpm} target="_blank" rel="noreferrer" className="font-semibold text-brand hover:underline">
              satchel-pay-mcp on npm ↗
            </a>
          </div>
          <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
            <h3 className="font-display text-[19px] font-semibold">Sell your API to agents</h3>
            <p className="text-body">
              Put any Fetch API endpoint behind a BCH paywall: signed 402 challenges, payment checks, no database and no
              wallet software. Payments go straight to your address.
            </p>
            <code className="block overflow-x-auto whitespace-nowrap rounded-xl bg-ink px-4 py-3 font-mono text-[13px] text-[#e8ece6]">
              npm install satchel-pay-server
            </code>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <a href={LINKS.kitNpm} target="_blank" rel="noreferrer" className="font-semibold text-brand hover:underline">
                satchel-pay-server on npm ↗
              </a>
              <a href={LINKS.seller} target="_blank" rel="noreferrer" className="font-semibold text-brand hover:underline">
                Live example seller ↗
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
