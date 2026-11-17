import { binToHex, cashAddressToLockingBytecode, decodeTransaction, hexToBin } from "@bitauth/libauth";
import { memoForChallenge, type Challenge } from "./protocol.js";

/**
 * Checks that a raw transaction pays a challenge: an output pays `payTo` at least `amount` sats, and an OP_RETURN
 * output carries `"SC402" || nonce`. Returns an error message, or null when it pays. Accepts the tx at 0-conf.
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

  const memo = memoForChallenge(challenge);
  const hasMemo = tx.outputs.some((o) => o.lockingBytecode[0] === 0x6a && binToHex(o.lockingBytecode).includes(memo));
  if (!hasMemo) return "transaction is missing the SC402 nonce memo";
  return null;
}
