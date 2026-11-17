import { binToHex, cashAddressToLockingBytecode, sha256 } from "@bitauth/libauth";
import { getProvider } from "@/lib/server/electrum";

/**
 * Thin chain proxy for the browser (keeps Electrum server-side):
 *   { op: "height" }                      -> { height }
 *   { op: "utxos", addresses: string[] }  -> { utxos: { [address]: Utxo[] } }   (bigints as strings)
 *   { op: "history", addresses: string[] } -> { txids: string[] }   (newest first, at most 25 per address)
 *   { op: "txs", txids: string[] }         -> { txs: { txid, hex }[] }   (at most 60)
 *   { op: "broadcast", hex }              -> { txid } | 400 { error }
 */

const HISTORY_PER_ADDRESS = 25;

function electrumScriptHash(address: string): string {
  const lb = cashAddressToLockingBytecode(address);
  if (typeof lb === "string") throw new Error(`invalid address ${address}`);
  return binToHex(sha256.hash(lb.bytecode).reverse());
}
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { op?: string; addresses?: unknown; hex?: unknown; txids?: unknown };
  const provider = getProvider();
  try {
    if (body.op === "height") return Response.json({ height: await provider.getBlockHeight() });

    if (body.op === "utxos") {
      const addresses = Array.isArray(body.addresses) ? body.addresses.slice(0, 60).map(String) : [];
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
      const addresses = Array.isArray(body.addresses) ? body.addresses.slice(0, 40).map(String) : [];
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
      const txids = Array.isArray(body.txids) ? body.txids.slice(0, 60).map(String) : [];
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
        return Response.json({ error: e instanceof Error ? e.message.split("\n")[0] : "broadcast failed" }, { status: 400 });
      }
    }
    return Response.json({ error: "unknown op" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "chain error" }, { status: 502 });
  }
}
