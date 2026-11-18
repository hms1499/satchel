import { z } from "zod";
import { decodeState, getVaultContract, lockingBytecodeOf, remainingBudget, type VaultParams } from "../../src/lib/vault";
import { binToHex, type NetworkProvider, type SpendableUtxo } from "../../src/lib/chain-deps";
import { decodeConnectCode, type ConnectInfo } from "../../src/lib/connect-code";
import { paramsFromDescriptorParams } from "../../src/lib/descriptor";
import { explorerTxUrl, type BchNetwork } from "../../src/lib/config";
import { normalizePayee } from "../../src/lib/payees";
import { VaultSpender, type PaymentOutcome } from "../../src/lib/spend";
import { encodePaymentHeader, memoForChallenge, parseChallenge, retryPaidRequest } from "../../src/lib/x402-client";
import { loadOrCreateAgentKey, type AgentKey } from "./keystore";
import { loadVault, saveVault } from "./vault-store";
import type { McpConfig } from "./config";
import type { CatalogEntry } from "../../provider-kit/src/paywall";

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
/** Each seller's /.well-known/satchel.json gets this long before satchel_catalog reports it as failed. */
const SELLER_TIMEOUT_MS = 5_000;
/** Seller catalogs are untrusted input: read at most this much, and cap string and array sizes. */
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_CATALOG_TOOLS = 50;
const MAX_TEXT = 500;
const DUST_SATS = 546n;
const MAX_MEMO_BYTES = 100;
/** satchel_send memos go in the covenant's optional OP_RETURN output as "SATM" || utf8(memo). */
const SEND_MEMO_PREFIX_HEX = binToHex(new TextEncoder().encode("SATM"));

/** Same locking bytecode. An address that does not decode matches nothing. */
const sameAddress = (a: string, b: string) => {
  try {
    return binToHex(lockingBytecodeOf(a)) === binToHex(lockingBytecodeOf(b));
  } catch {
    return false;
  }
};

/** What a seller serves at /.well-known/satchel.json (satchel-pay-server's `wellKnownResponse`). Never trusted unchecked. */
const WellKnownSchema = z.object({
  name: z.string().max(MAX_TEXT),
  network: z.enum(["mainnet", "chipnet"]),
  tools: z.array(
    z.object({
      name: z.string().min(1).max(MAX_TEXT),
      title: z.string().max(MAX_TEXT),
      description: z.string().max(MAX_TEXT),
      price: z.string().regex(/^\d+$/).max(20),
      params: z.record(z.string().max(MAX_TEXT), z.string().max(MAX_TEXT)),
      payTo: z.string().max(MAX_TEXT),
      endpoint: z.string().url().max(2000),
    }),
  ).max(MAX_CATALOG_TOOLS),
}) satisfies z.ZodType<{ name: string; network: BchNetwork; tools: CatalogEntry[] }>;

/** The response body as JSON, refusing anything over `limit` bytes. */
async function readJsonLimited(res: Response, limit: number): Promise<unknown> {
  const tooLarge = () => new Error(`catalog is too large (over ${limit / 1024} KB)`);
  if (Number(res.headers.get("content-length") ?? 0) > limit) throw tooLarge();
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > limit) throw tooLarge();
    return JSON.parse(text);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

type SellerCatalog = { origin: string; ok: boolean; error?: string; tools?: unknown[] };

/** The http(s) origins of a connect code's seller URLs, deduplicated. Anything else is skipped. */
function httpOrigins(urls: string[] = []): string[] {
  const origins = urls.flatMap((u) => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" || url.protocol === "http:" ? [url.origin] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(origins)];
}

const labelOf = (info: ConnectInfo, address: string): string | null =>
  Object.entries(info.labels ?? {}).find(([a]) => sameAddress(a, address))?.[1] ?? null;

const paymentFailure = (payment: Extract<PaymentOutcome, { ok: false }>): ToolResult =>
  payment.covenant
    ? fail(`The vault's covenant refused this payment: ${payment.reason}. The budget for this period is used up or the payee is not allowed.${payment.rule ? ` Failing rule: ${payment.rule}` : ""}`)
    : fail(`Payment failed: ${payment.reason}`);

export function createHandlers(deps: HandlerDeps) {
  const { cfg, provider, spender } = deps;
  let key: AgentKey | undefined;
  const agent = () => (key ??= loadOrCreateAgentKey(cfg));

  const vaultOf = (info: ConnectInfo) => {
    const params: VaultParams = paramsFromDescriptorParams(info.params);
    return { params, contract: getVaultContract(params, provider) };
  };

  type OpenVault = ReturnType<typeof vaultOf> & { info: ConnectInfo; utxo: SpendableUtxo };
  /** The connected vault and its current state UTXO, or a ready-to-return error. */
  const openVault = async (info = loadVault(cfg)): Promise<OpenVault | { error: ToolResult }> => {
    if (!info) return { error: fail(NOT_CONNECTED) };
    const v = vaultOf(info);
    const utxo = await spender.currentVaultUtxo(v);
    if (!utxo) return { error: fail(CLOSED) };
    return { ...v, info, utxo };
  };

  /** True when satchel_pay_fetch would pay this entry: an allowlisted payee on an allowed payment origin. */
  const payable = (allowlist: string[], payTo: string, endpoint: string) => {
    let origin: string;
    try {
      origin = new URL(endpoint).origin;
    } catch {
      return false;
    }
    return cfg.payOrigins.includes(origin) && allowlist.some((a) => sameAddress(a, payTo));
  };

  /** One seller's catalog. A seller that is down, slow or serves anything invalid is reported, never thrown. */
  const sellerCatalog = async (origin: string, allowlist: string[], info?: ConnectInfo): Promise<SellerCatalog> => {
    let body: unknown;
    try {
      const res = await deps.fetch(`${origin}/.well-known/satchel.json`, { signal: AbortSignal.timeout(SELLER_TIMEOUT_MS) });
      if (!res.ok) return { origin, ok: false, error: `/.well-known/satchel.json answered HTTP ${res.status}` };
      body = await readJsonLimited(res, MAX_CATALOG_BYTES);
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      return { origin, ok: false, error: timedOut ? `no answer within ${SELLER_TIMEOUT_MS / 1000} s` : `could not load /.well-known/satchel.json (${e instanceof Error ? e.message : String(e)})` };
    }
    const parsed = WellKnownSchema.safeParse(body);
    if (!parsed.success) return { origin, ok: false, error: "/.well-known/satchel.json is not a valid Satchel seller catalog" };
    if (parsed.data.network !== cfg.network) return { origin, ok: false, error: `this seller is on ${parsed.data.network}, but this server runs on ${cfg.network}` };
    return {
      origin,
      ok: true,
      tools: parsed.data.tools.map((t) => {
        const payeeLabel = info ? labelOf(info, t.payTo) : null;
        return { ...t, allowed: payable(allowlist, t.payTo, t.endpoint), ...(payeeLabel ? { payeeLabel } : {}) };
      }),
    };
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
      // The code can only suggest sellers: SATCHEL_PAY_ORIGINS (set by the user) stays the only list this server pays.
      const sellerOrigins = httpOrigins(info.sellers);
      const addToPayOrigins = sellerOrigins.filter((o) => !cfg.payOrigins.includes(o));
      return ok({
        connected: v.contract.address,
        ...(previousAddress && previousAddress !== v.contract.address ? { replaced: previousAddress } : {}),
        balance: utxo.satoshis,
        capPerPeriod: v.params.capPerPeriod,
        periodBlocks: v.params.periodBlocks,
        allowlist: v.params.allowlist,
        sellerOrigins,
        ...(addToPayOrigins.length
          ? {
              addToPayOrigins,
              howToAddSellers: "To buy from these sellers, ask the user to add them to SATCHEL_PAY_ORIGINS (comma-separated) in this MCP server's config and restart it.",
            }
          : {}),
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
        payees: v.params.allowlist.map((address) => ({ address, label: labelOf(v.info, address) })),
        maxPricePerCall: cfg.maxPriceSats,
      });
    },

    async catalog(): Promise<ToolResult> {
      const info = loadVault(cfg);
      const allowlist = info?.params.allowlist ?? [];
      const satchelOrigin = new URL(cfg.satchelUrl).origin;
      const loadConfig = async (): Promise<{ tools: { name: string; title: string; description: string; price: string; payTo: string; params?: Record<string, string> }[] } | string> => {
        try {
          const res = await deps.fetch(`${cfg.satchelUrl}/api/config`, { signal: AbortSignal.timeout(SELLER_TIMEOUT_MS) });
          if (!res.ok) return `${cfg.satchelUrl}/api/config answered HTTP ${res.status}`;
          return (await res.json()) as { tools: never[] };
        } catch (e) {
          const timedOut = e instanceof Error && e.name === "TimeoutError";
          return timedOut ? `no answer from ${cfg.satchelUrl} within ${SELLER_TIMEOUT_MS / 1000} s` : `could not load the tool catalog from ${cfg.satchelUrl}`;
        }
      };
      const [config, sellers] = await Promise.all([
        loadConfig(),
        Promise.all(cfg.payOrigins.filter((o) => o !== satchelOrigin).map((o) => sellerCatalog(o, allowlist, info ?? undefined))),
      ]);
      // Satchel being down must not hide the sellers' tools.
      if (typeof config === "string") return ok({ tools: [], satchelError: config, sellers, howToCall: "satchel_pay_fetch with { url: endpoint, body: { ...tool parameters } }" });
      return ok({
        tools: config.tools.map((t) => {
          const endpoint = `${cfg.satchelUrl}/api/tools/${t.name}`;
          return {
            name: t.name,
            title: t.title,
            description: t.description,
            endpoint,
            price: t.price,
            params: t.params ?? {},
            payTo: t.payTo,
            allowed: payable(allowlist, t.payTo, endpoint),
          };
        }),
        sellers,
        howToCall: "satchel_pay_fetch with { url: endpoint, body: { ...tool parameters } }",
      });
    },

    async send(args: { to: string; amountSats: number; memo?: string }): Promise<ToolResult> {
      // Every guard runs before anything is signed.
      const info = loadVault(cfg);
      if (!info) return fail(NOT_CONNECTED);
      const payee = normalizePayee(args.to, cfg.network);
      if (!payee.ok) return fail(`Not sending to "${args.to}": ${payee.error}.`);
      // The covenant spend needs the allowlist entry itself (its index), so pay that entry.
      const to = info.params.allowlist.find((a) => sameAddress(a, payee.address));
      if (!to) return fail(`Not sending: ${payee.address} is not in this vault's allowlist. satchel_status lists the payees this vault may pay.`);
      if (!Number.isSafeInteger(args.amountSats)) return fail("Not sending: amountSats must be a whole number of sats.");
      const amount = BigInt(args.amountSats);
      if (amount < DUST_SATS) return fail(`Not sending: ${amount} sats is below the ${DUST_SATS}-sat dust limit.`);
      if (amount > cfg.maxSendSats) return fail(`Not sending: ${amount} sats exceeds SATCHEL_MAX_SEND_SATS (${cfg.maxSendSats}).`);
      const memo = new TextEncoder().encode(args.memo ?? "");
      if (memo.length > MAX_MEMO_BYTES) return fail(`Not sending: the memo is ${memo.length} bytes in UTF-8; the limit is ${MAX_MEMO_BYTES} bytes.`);

      const v = await openVault(info);
      if ("error" in v) return v.error;
      const memoHex = memo.length > 0 ? SEND_MEMO_PREFIX_HEX + binToHex(memo) : undefined;
      const payment = await spender.pay({ ...v, agentSigner: agent().signer, provider }, to, amount, memoHex);
      if (!payment.ok) return paymentFailure(payment);
      return ok({
        txid: payment.txid,
        explorer: explorerTxUrl(cfg.network, payment.txid),
        to,
        label: labelOf(info, to),
        amount: payment.amount,
        fee: payment.fee,
        spentThisPeriod: payment.spentInPeriod,
        remaining: payment.remaining,
        balance: payment.balance,
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
      // Pay the allowlist entry itself (the covenant spend needs its index): the challenge may name it in another form.
      const payTo = v.params.allowlist.find((a) => sameAddress(a, challenge.payTo));
      if (!payTo) return fail(`Not paying: payee ${challenge.payTo} is not in this vault's allowlist; not paying.`);
      if (amount > cfg.maxPriceSats) {
        return fail(`Not paying: the price ${amount} sats exceeds SATCHEL_MAX_PRICE_SATS (${cfg.maxPriceSats}).`);
      }

      const target = { ...v, agentSigner: agent().signer, provider };
      const payment = await spender.pay(target, payTo, amount, memoForChallenge(challenge));
      if (!payment.ok) return paymentFailure(payment);

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
