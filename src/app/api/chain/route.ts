import { cashAddressToLockingBytecode } from "@bitauth/libauth";
import { getProvider } from "@/lib/server/electrum";

/**
 * Thin chain proxy for the browser (keeps Electrum server-side):
 *   { op: "height" }                      -> { height }
 *   { op: "utxos", addresses: string[] }  -> { utxos: { [address]: Utxo[] } }   (bigints as strings)
 *   { op: "broadcast", hex }              -> { txid } | 400 { error }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { op?: string; addresses?: unknown; hex?: unknown };
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
