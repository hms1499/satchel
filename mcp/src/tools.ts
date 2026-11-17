import { decodeState, getVaultContract, lockingBytecodeOf, remainingBudget, type VaultParams } from "../../src/lib/vault";
import { binToHex, type NetworkProvider, type SpendableUtxo } from "../../src/lib/chain-deps";
import { decodeConnectCode, type ConnectInfo } from "../../src/lib/connect-code";
import { paramsFromDescriptorParams } from "../../src/lib/descriptor";
import { explorerTxUrl } from "../../src/lib/config";
import { VaultSpender } from "../../src/lib/spend";
import { encodePaymentHeader, memoForChallenge, parseChallenge, retryPaidRequest } from "../../src/lib/x402-client";
import { loadOrCreateAgentKey, type AgentKey } from "./keystore";
import { loadVault, saveVault } from "./vault-store";
import type { McpConfig } from "./config";

export type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

export interface HandlerDeps {
  cfg: McpConfig;
  provider: NetworkProvider;
  fetch: typeof fetch;
  spender: VaultSpender;
}

const show = (data: unknown) => JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: show(data) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const NOT_CONNECTED = "No vault is connected. Run satchel_setup, create the vault from its link, then paste the connect code into satchel_connect.";
const CLOSED = "The vault is closed: its owner withdrew the funds. Run satchel_setup to create a new vault for this agent.";

/** A challenge must leave time to pay and retry before it expires. */
const MIN_CHALLENGE_LIFETIME_MS = 30_000;

const sameAddress = (a: string, b: string) => binToHex(lockingBytecodeOf(a)) === binToHex(lockingBytecodeOf(b));

export function createHandlers(deps: HandlerDeps) {
  const { cfg, provider, spender } = deps;
  let key: AgentKey | undefined;
  const agent = () => (key ??= loadOrCreateAgentKey(cfg));

  const vaultOf = (info: ConnectInfo) => {
    const params: VaultParams = paramsFromDescriptorParams(info.params);
    return { params, contract: getVaultContract(params, provider) };
  };

  type OpenVault = ReturnType<typeof vaultOf> & { utxo: SpendableUtxo };
  /** The connected vault and its current state UTXO, or a ready-to-return error. */
  const openVault = async (): Promise<OpenVault | { error: ToolResult }> => {
    const info = loadVault(cfg);
    if (!info) return { error: fail(NOT_CONNECTED) };
    const v = vaultOf(info);
    const utxo = await spender.currentVaultUtxo(v);
    if (!utxo) return { error: fail(CLOSED) };
    return { ...v, utxo };
  };

  return {
    async setup(): Promise<ToolResult> {
      const k = agent();
      const info = loadVault(cfg);
      return ok({
        agentPk: k.pubHex,
        network: cfg.network,
        createVaultUrl: `${cfg.satchelUrl}/?agent=${k.pubHex}`,
        connectedVault: info ? vaultOf(info).contract.address : null,
        next: info
          ? "A vault is connected. Use satchel_status and satchel_pay_fetch."
          : "Open createVaultUrl, create the vault with your wallet, then paste the connect code it shows into satchel_connect.",
      });
    },

    async connect(code: string): Promise<ToolResult> {
      const decoded = decodeConnectCode(code);
      if (!decoded.ok) return fail(`That is not a valid connect code (${decoded.error}).`);
      const { info } = decoded;
      if (info.network !== cfg.network) return fail(`This connect code is for ${info.network}, but this server runs on ${cfg.network} (SATCHEL_NETWORK).`);
      if (info.params.agentPk !== agent().pubHex) {
        return fail("This vault was created for another agent key, so this agent cannot spend from it. Run satchel_setup and create the vault from the link it returns.");
      }
      const v = vaultOf(info);
      const utxo = await spender.currentVaultUtxo(v);
      if (!utxo) return fail("No open vault was found on chain for this code: it was not created yet, or it was already withdrawn.");
      const previous = loadVault(cfg);
      saveVault(cfg, info);
      const previousAddress = previous ? vaultOf(previous).contract.address : null;
      return ok({
        connected: v.contract.address,
        ...(previousAddress && previousAddress !== v.contract.address ? { replaced: previousAddress } : {}),
        balance: utxo.satoshis,
        capPerPeriod: v.params.capPerPeriod,
        periodBlocks: v.params.periodBlocks,
        allowlist: v.params.allowlist,
      });
    },

    async status(): Promise<ToolResult> {
      const v = await openVault();
      if ("error" in v) return v.error;
      const state = decodeState(v.utxo.token!.nft!.commitment);
      const tipHeight = await provider.getBlockHeight();
      const budget = remainingBudget(state, tipHeight, v.params);
      return ok({
        vault: v.contract.address,
        network: cfg.network,
        balance: v.utxo.satoshis,
        spentThisPeriod: state.spent,
        remaining: budget.remaining,
        resetsAtHeight: budget.resetsAtHeight,
        tipHeight,
        capPerPeriod: v.params.capPerPeriod,
        periodBlocks: v.params.periodBlocks,
        allowlist: v.params.allowlist,
        maxPricePerCall: cfg.maxPriceSats,
      });
    },

    async catalog(): Promise<ToolResult> {
      const res = await deps.fetch(`${cfg.satchelUrl}/api/config`).catch(() => null);
      if (!res?.ok) return fail(`Could not load the tool catalog from ${cfg.satchelUrl}.`);
      const config = (await res.json()) as { tools: { name: string; title: string; description: string; price: string; payTo: string; params?: Record<string, string> }[] };
      const info = loadVault(cfg);
      const allowlist = info?.params.allowlist ?? [];
      return ok({
        tools: config.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          endpoint: `${cfg.satchelUrl}/api/tools/${t.name}`,
          price: t.price,
          params: t.params ?? {},
          payTo: t.payTo,
          allowed: allowlist.some((a) => sameAddress(a, t.payTo)),
        })),
        howToCall: "satchel_pay_fetch with { url: endpoint, body: { ...tool parameters } }",
      });
    },

    async payFetch(args: { url: string; method?: "GET" | "POST"; body?: Record<string, unknown> }): Promise<ToolResult> {
      let targetUrl: URL;
      try {
        targetUrl = new URL(args.url);
      } catch {
        return fail(`Not paying: "${args.url}" is not a valid URL.`);
      }
      // Pay only providers the user trusts: Satchel's own origin, plus any listed in SATCHEL_PAY_ORIGINS. A URL the
      // agent picked up from a web page or a document (prompt injection) cannot make the vault pay.
      if (!cfg.payOrigins.includes(targetUrl.origin)) {
        return fail(`Not paying: ${targetUrl.origin} is not an allowed payment origin (allowed: ${cfg.payOrigins.join(", ")}). The user can add it to SATCHEL_PAY_ORIGINS.`);
      }
      const v = await openVault();
      if ("error" in v) return v.error;
      const method = args.method ?? "POST";
      const request = (extra: Record<string, string> = {}) =>
        deps.fetch(args.url, {
          method,
          headers: { "content-type": "application/json", ...extra },
          ...(method === "POST" ? { body: JSON.stringify(args.body ?? {}) } : {}),
        });

      let first: Response;
      try {
        first = await request();
      } catch (e) {
        return fail(`Could not reach ${args.url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const firstBody = await first.json().catch(() => ({}));
      if (first.status !== 402) {
        return first.ok ? ok({ result: (firstBody as { result?: unknown }).result ?? firstBody, payment: null }) : fail(`The endpoint answered HTTP ${first.status}.`);
      }

      const parsed = parseChallenge(firstBody, cfg.network);
      if (!parsed.ok) return fail(`Not paying: ${parsed.error}.`);
      const { challenge } = parsed;
      // The challenge must be for the endpoint we called (a challenge relayed from another resource is refused)
      // and must not be about to expire.
      if (challenge.resource !== targetUrl.pathname) {
        return fail(`Not paying: the payment challenge is for another resource (${challenge.resource}), not ${targetUrl.pathname}.`);
      }
      if (challenge.expires < Date.now() + MIN_CHALLENGE_LIFETIME_MS) return fail("Not paying: the payment challenge is expired or about to expire.");
      const amount = BigInt(challenge.amount);
      if (!v.params.allowlist.some((a) => sameAddress(a, challenge.payTo))) {
        return fail(`Not paying: payee ${challenge.payTo} is not in this vault's allowlist; not paying.`);
      }
      if (amount > cfg.maxPriceSats) {
        return fail(`Not paying: the price ${amount} sats exceeds SATCHEL_MAX_PRICE_SATS (${cfg.maxPriceSats}).`);
      }

      const target = { ...v, agentSigner: agent().signer, provider };
      const payment = await spender.pay(target, challenge.payTo, amount, memoForChallenge(challenge));
      if (!payment.ok) {
        return payment.covenant
          ? fail(`The vault's covenant refused this payment: ${payment.reason}. The budget for this period is used up or the payee is not allowed.${payment.rule ? ` Failing rule: ${payment.rule}` : ""}`)
          : fail(`Payment failed: ${payment.reason}`);
      }

      const header = encodePaymentHeader(challenge, payment.txid);
      const result = await retryPaidRequest(() => request({ "x-payment": header }));
      const receipt = {
        txid: payment.txid,
        explorer: explorerTxUrl(cfg.network, payment.txid),
        amount: payment.amount,
        fee: payment.fee,
        spentThisPeriod: payment.spentInPeriod,
        remaining: payment.remaining,
      };
      if (!result.ok) {
        return fail(`Paid ${payment.amount} sats (txid ${payment.txid}), but the endpoint then failed: ${result.error}. ${receipt.explorer}`);
      }
      return ok({ result: result.result, payment: receipt });
    },
  };
}
