import { binToHex, cashAddressToLockingBytecode, sha256 } from "@bitauth/libauth";
import { getProvider } from "@/lib/server/electrum";
import { allowRequest } from "@/lib/server/rate-limit";

/**
 * Thin chain proxy for the browser (keeps Electrum server-side):
 *   { op: "height" }                      -> { height }
 *   { op: "utxos", addresses: string[] }  -> { utxos: { [address]: Utxo[] } }   (bigints as strings)
 *   { op: "history", addresses: string[] } -> { txids: string[] }   (newest first, at most 25 per address)
 *   { op: "txs", txids: string[] }         -> { txs: { txid, hex }[] }   (at most 60)
 *   { op: "broadcast", hex }              -> { txid } | 400 { error }
 */

const HISTORY_PER_ADDRESS = 25;
// Request caps: the browser's wallet scan sends 20 addresses (2 paths x 10) and up to 60 txids (recovery).
const MAX_ADDRESSES = 20;
const MAX_TXIDS = 60;

const tooMany = (what: "addresses" | "txids", max: number) => Response.json({ error: `too many ${what} (max ${max})` }, { status: 400 });

function electrumScriptHash(address: string): string {
  const lb = cashAddressToLockingBytecode(address);
  if (typeof lb === "string") throw new Error(`invalid address ${address}`);
  return binToHex(sha256.hash(lb.bytecode).reverse());
}
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await allowRequest(`chain:${ip}`))) return Response.json({ error: "rate limited, try again in a minute" }, { status: 429 });
  const body = (await request.json().catch(() => ({}))) as { op?: string; addresses?: unknown; hex?: unknown; txids?: unknown };
  const provider = getProvider();
  try {
    if (body.op === "height") return Response.json({ height: await provider.getBlockHeight() });

    if (body.op === "utxos") {
      const addresses = Array.isArray(body.addresses) ? body.addresses.map(String) : [];
      if (addresses.length > MAX_ADDRESSES) return tooMany("addresses", MAX_ADDRESSES);
      for (const a of addresses) {
        if (typeof cashAddressToLockingBytecode(a) === "string") return Response.json({ error: `invalid address ${a}` }, { status: 400 });
      }
      const entries = await Promise.all(
        addresses.map(async (a) => {
          const utxos = await provider.getUtxos(a);
          return [a, JSON.parse(JSON.stringify(utxos, (_, v) => (typeof v === "bigint" ? v.toString() : v)))] as const;
        }),
      );
      return Response.json({ utxos: Object.fromEntries(entries) });
    }

    if (body.op === "history") {
      const addresses = Array.isArray(body.addresses) ? body.addresses.map(String) : [];
      if (addresses.length > MAX_ADDRESSES) return tooMany("addresses", MAX_ADDRESSES);
      const hashes = addresses.map(electrumScriptHash);
      const lists = await Promise.all(
        hashes.map(async (h) => {
          const history = (await provider.performRequest("blockchain.scripthash.get_history", h)) as { tx_hash: string; height: number }[];
          // Unconfirmed (height <= 0) first, then newest blocks first.
          const rank = (x: { height: number }) => (x.height <= 0 ? Number.MAX_SAFE_INTEGER : x.height);
          return [...history].sort((a, b) => rank(b) - rank(a)).slice(0, HISTORY_PER_ADDRESS).map((x) => x.tx_hash);
        }),
      );
      return Response.json({ txids: [...new Set(lists.flat())] });
    }

    if (body.op === "txs") {
      const txids = Array.isArray(body.txids) ? body.txids.map(String) : [];
      if (txids.length > MAX_TXIDS) return tooMany("txids", MAX_TXIDS);
      if (txids.some((t) => !/^[0-9a-f]{64}$/.test(t))) return Response.json({ error: "invalid txid" }, { status: 400 });
      const txs = await Promise.all(txids.map(async (txid) => ({ txid, hex: (await provider.getRawTransaction(txid)) as string })));
      return Response.json({ txs });
    }

    if (body.op === "broadcast") {
      const hex = String(body.hex ?? "");
      if (!/^[0-9a-f]+$/i.test(hex) || hex.length > 200_000) return Response.json({ error: "invalid transaction hex" }, { status: 400 });
      try {
        return Response.json({ txid: await provider.sendRawTransaction(hex) });
      } catch (e) {
        // Keep the node's full reason (Fulcrum puts it after the first line), e.g. "mandatory-script-verify-flag-failed (...)".
        const message = e instanceof Error ? e.message.replace(/\s+/g, " ").trim() : "broadcast failed";
        console.error(`[chain] broadcast rejected: ${message}\n[chain] tx hex: ${hex}`);
        return Response.json({ error: message }, { status: 400 });
      }
    }
    return Response.json({ error: "unknown op" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "chain error" }, { status: 502 });
  }
}
