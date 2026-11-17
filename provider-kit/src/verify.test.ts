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

const CHALLENGE_OPTS = {
  resource: "/api/tools/crypto-price",
  payTo: PAY_TO,
  amount: 1_000n,
  request: "aa".repeat(32),
  network: "chipnet" as const,
  secret: "verify-test-secret-0123456789abcdef0123456789",
};
const challenge = createChallenge(CHALLENGE_OPTS);

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

  it("accepts the memo output exactly as Satchel clients build it (cashscript addOpReturnOutput)", () => {
    // vault.ts: builder.addOpReturnOutput([`0x${memo}`]) encodes OP_RETURN + one 21-byte push.
    const asBuilt = { lockingBytecode: hexToBin("6a15" + memoForChallenge(challenge)), valueSatoshis: 0n };
    const vaultOut = { lockingBytecode: hexToBin("a914" + "22".repeat(20) + "87"), valueSatoshis: 50_000n };
    expect(verifyPaymentTx(txHex([vaultOut, { lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_000n }, asBuilt]), challenge)).toBeNull();
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

  it("rejects two memos pushed in one OP_RETURN (one payment for two challenges)", () => {
    const second = createChallenge({ ...CHALLENGE_OPTS, request: "bb".repeat(32) });
    const both = { lockingBytecode: hexToBin("6a15" + memoForChallenge(challenge) + "15" + memoForChallenge(second)), valueSatoshis: 0n };
    const tx = txHex([{ lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_000n }, both]);
    expect(verifyPaymentTx(tx, challenge)).toBe("transaction is missing the SC402 nonce memo");
    expect(verifyPaymentTx(tx, second)).toBe("transaction is missing the SC402 nonce memo");
  });

  it("rejects a memo with extra bytes after it", () => {
    const padded = { lockingBytecode: hexToBin("6a16" + memoForChallenge(challenge) + "00"), valueSatoshis: 0n };
    expect(verifyPaymentTx(txHex([{ lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_000n }, padded]), challenge)).toBe(
      "transaction is missing the SC402 nonce memo",
    );
  });

  it("rejects two OP_RETURN outputs", () => {
    const second = createChallenge({ ...CHALLENGE_OPTS, request: "bb".repeat(32) });
    const tx = txHex([{ lockingBytecode: lockingBytecode(PAY_TO), valueSatoshis: 1_000n }, memo, opReturn(memoForChallenge(second))]);
    expect(verifyPaymentTx(tx, challenge)).toBe("transaction has more than one OP_RETURN output");
    expect(verifyPaymentTx(tx, second)).toBe("transaction has more than one OP_RETURN output");
  });

  it("rejects bytes that are not a transaction", () => {
    expect(verifyPaymentTx("00", challenge)).toBe("could not decode transaction");
  });
});
