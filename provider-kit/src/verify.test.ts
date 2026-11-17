import { describe, it, expect } from "vitest";
import { binToHex, cashAddressToLockingBytecode, encodeTransaction, hexToBin, utf8ToBin } from "@bitauth/libauth";
import { createChallenge } from "./challenge.js";
import { MEMO_PREFIX_HEX, memoForChallenge } from "./protocol.js";
import { verifyPaymentTx } from "./verify.js";

const PAY_TO = "bchtest:qzhw4v5cag3h98392ktmmaean9wysfmdvuc0drgy7h";

/** Another P2PKH locking bytecode (a different 20-byte hash). */
const OTHER_BYTECODE = hexToBin("76a914" + "11".repeat(20) + "88ac");

const lockingBytecode = (address: string) => {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === "string") throw new Error(r);
  return r.bytecode;
};

const challenge = createChallenge({
  resource: "/api/tools/crypto-price",
  payTo: PAY_TO,
  amount: 1_000n,
  request: "aa".repeat(32),
  network: "chipnet",
  secret: "verify-test-secret-0123456789abcdef0123456789",
});

/** A real, libauth-encoded transaction (an OP_RETURN push of `data` when given). */
function txHex(outputs: { lockingBytecode: Uint8Array; valueSatoshis: bigint }[]): string {
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(7), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
      outputs,
    }),
  );
}
const opReturn = (dataHex: string) => ({ lockingBytecode: hexToBin("6a" + (dataHex.length / 2).toString(16).padStart(2, "0") + dataHex), valueSatoshis: 0n });
const memo = opReturn(memoForChallenge(challenge));

describe("memoForChallenge", () => {
  it('is "SC402" || nonce', () => {
    expect(MEMO_PREFIX_HEX).toBe(binToHex(utf8ToBin("SC402")));
    expect(memoForChallenge({ nonce: "00".repeat(16) })).toBe(binToHex(utf8ToBin("SC402")) + "00".repeat(16));
  });
});

describe("verifyPaymentTx", () => {
  it("accepts a tx paying payTo the amount with the SC402 nonce memo", () => {
    expect(verifyPaymentTx(txHex([{ lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_000n }, memo]), challenge)).toBeNull();
  });

  it("accepts an overpayment, in any output order", () => {
    expect(
      verifyPaymentTx(
        txHex([memo, { lockingBytecode: OTHER_BYTECODE, valueSatoshis: 5_000n }, { lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_500n }]),
        challenge,
      ),
    ).toBeNull();
  });

  it("rejects an underpayment", () => {
    expect(verifyPaymentTx(txHex([{ lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 999n }, memo]), challenge)).toBe(
      "transaction does not pay the required amount to payTo",
    );
  });

  it("rejects a payment to another address", () => {
    expect(verifyPaymentTx(txHex([{ lockingBytecode: OTHER_BYTECODE, valueSatoshis: 1_000n }, memo]), challenge)).toBe(
      "transaction does not pay the required amount to payTo",
    );
  });

  it("rejects a tx without the memo", () => {
    expect(verifyPaymentTx(txHex([{ lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_000n }]), challenge)).toBe(
      "transaction is missing the SC402 nonce memo",
    );
  });

  it("rejects an unrelated OP_RETURN", () => {
    const unrelated = opReturn(binToHex(utf8ToBin("SC402")) + "ff".repeat(16));
    expect(verifyPaymentTx(txHex([{ lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_000n }, unrelated]), challenge)).toBe(
      "transaction is missing the SC402 nonce memo",
    );
  });

  it("rejects the memo bytes outside an OP_RETURN output", () => {
    const notOpReturn = { lockingBytecode: hexToBin("15" + memoForChallenge(challenge)), valueSatoshis: 0n };
    expect(verifyPaymentTx(txHex([{ lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_000n }, notOpReturn]), challenge)).toBe(
      "transaction is missing the SC402 nonce memo",
    );
  });

  it("rejects bytes that are not a transaction", () => {
    expect(verifyPaymentTx("00", challenge)).toBe("could not decode transaction");
  });
});
