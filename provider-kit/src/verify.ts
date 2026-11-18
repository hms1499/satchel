import { base64ToBin, binToHex, binToUtf8, cashAddressToLockingBytecode, decodeTransaction, hexToBin, isBase64 } from "@bitauth/libauth";
import { checkChallenge } from "./challenge";
import { memoForChallenge, type BchNetwork, type Challenge } from "./protocol";

/**
 * Checks that a raw transaction pays a challenge: an output pays `payTo` at least `amount` sats, and its only OP_RETURN
 * output is exactly `OP_RETURN <"SC402" || nonce>`. Returns an error message, or null when it pays. Accepts the tx at 0-conf.
 */
export function verifyPaymentTx(rawHex: string, challenge: Challenge): string | null {
  const tx = decodeTransaction(hexToBin(rawHex));
  if (typeof tx === "string") return "could not decode transaction";

  const payTo = cashAddressToLockingBytecode(challenge.payTo);
  if (typeof payTo === "string") return "invalid payTo address";
  const payToBytecode = binToHex(payTo.bytecode);
  const paid = tx.outputs.some(
    (o) => binToHex(o.lockingBytecode) === payToBytecode && o.valueSatoshis >= BigInt(challenge.amount),
  );
  if (!paid) return "transaction does not pay the required amount to payTo";

  // Exactly one OP_RETURN, and it is exactly OP_RETURN <push of "SC402" || nonce> (what Satchel clients build), so one
  // transaction can never carry the memos of several challenges and pay for several calls at once.
  const opReturns = tx.outputs.filter((o) => o.lockingBytecode[0] === 0x6a);
  if (opReturns.length > 1) return "transaction has more than one OP_RETURN output";
  const expected = "6a15" + memoForChallenge(challenge); // 0x15 = push of 21 bytes: "SC402" (5) || nonce (16)
  if (opReturns.length === 0 || binToHex(opReturns[0].lockingBytecode) !== expected) {
    return "transaction is missing the SC402 nonce memo";
  }
  return null;
}

function decodeHeader(header: string): { challenge?: Challenge; txid?: unknown } | undefined {
  if (!isBase64(header)) return undefined;
  try {
    const parsed: unknown = JSON.parse(binToUtf8(base64ToBin(header)));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies an `X-Payment` header (`base64(JSON {challenge, txid})`) for one request: the challenge's signature,
 * resource, request binding and expiry, then the paying transaction (fetched with `getTransaction`, accepted at 0-conf).
 */
export async function verifyPaymentHeader(
  header: string,
  o: { resource: string; request: string; network: BchNetwork; secret: string; getTransaction: (txid: string) => Promise<string>; now?: number },
): Promise<{ ok: true; txid: string; challenge: Challenge } | { ok: false; error: string }> {
  const parsed = decodeHeader(header);
  if (!parsed) return { ok: false, error: "malformed X-Payment header" };
  const { challenge, txid } = parsed;
  const invalid = checkChallenge(challenge, { resource: o.resource, request: o.request, network: o.network, secret: o.secret, now: o.now });
  if (invalid || !challenge) return { ok: false, error: invalid ?? "invalid challenge signature" };
  if (typeof txid !== "string" || !/^[0-9a-f]{64}$/.test(txid)) return { ok: false, error: "invalid txid" };

  let rawHex: string;
  try {
    rawHex = await o.getTransaction(txid);
  } catch {
    return { ok: false, error: "transaction not found on the network" };
  }
  const unpaid = verifyPaymentTx(rawHex, challenge);
  if (unpaid) return { ok: false, error: unpaid };
  return { ok: true, txid, challenge };
}
