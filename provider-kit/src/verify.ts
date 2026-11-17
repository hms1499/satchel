import { binToHex, cashAddressToLockingBytecode, decodeTransaction, hexToBin } from "@bitauth/libauth";
import { memoForChallenge, type Challenge } from "./protocol";

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
