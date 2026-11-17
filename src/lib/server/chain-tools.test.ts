import { describe, it, expect } from "vitest";
import { binToHex, encodeCashAddress, encodeTransaction, hashTransaction, hexToBin, sha256, utf8ToBin } from "@bitauth/libauth";
import { NETWORK } from "../config";
import { prefixFor } from "../payees";
import { HOSTED_AGENT_TOOLS, PAID_TOOLS, PROVIDER_COUNT, TOOL_NAMES, defaultAllowed } from "../tools";
import { addressInfo, txInfo, withTimeout, type Rpc } from "./chain-tools";
import { ToolInputError, validateToolInput } from "./tool-impl";

const OTHER = NETWORK === "mainnet" ? "chipnet" : "mainnet";
const hash20 = (n: number) => new Uint8Array(20).fill(n);
const addr = (network: typeof NETWORK, payload: Uint8Array, type: "p2pkh" | "p2pkhWithTokens" = "p2pkh") =>
  encodeCashAddress({ prefix: prefixFor(network), type, payload }).address;
const p2pkhBytecode = (n: number) => Uint8Array.from([0x76, 0xa9, 0x14, ...hash20(n), 0x88, 0xac]);
const scripthashOf = (bytecode: Uint8Array) => binToHex(sha256.hash(bytecode).reverse());

// Fulcrum's real error for an unknown txid (captured from chipnet.bch.ninja).
const NOT_FOUND = "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.'})";

/** A stubbed Electrum: one handler per method, every call recorded. */
function stub(handlers: Record<string, (...params: unknown[]) => unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: Rpc = async (method, ...params) => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected call ${method}`);
    return handler(...params);
  };
  return { rpc, calls };
}

const CAT_A = "dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b";
const CAT_B = "3ef0600ee13aefc0c7d486be6edfd0c634852695eb8d3375144aeebe60cca1cb";

describe("bch-address", () => {
  const holder = addr(NETWORK, hash20(1));
  const scripthash = scripthashOf(p2pkhBytecode(1));
  // Shapes as Fulcrum returns them (listunspent with "include_tokens").
  const utxos = [
    { height: 335368, tx_hash: "aa".repeat(32), tx_pos: 0, value: 1000, token_data: { amount: "0", category: CAT_A, nft: { capability: "mutable", commitment: "0040" } } },
    { height: 335368, tx_hash: "bb".repeat(32), tx_pos: 1, value: 1000, token_data: { amount: "250", category: CAT_B } },
    { height: 335369, tx_hash: "cc".repeat(32), tx_pos: 0, value: 1000, token_data: { amount: "9007199254740993", category: CAT_B, nft: { capability: "none", commitment: "" } } },
    { height: 335369, tx_hash: "dd".repeat(32), tx_pos: 0, value: 1000, token_data: { amount: "0", category: CAT_A, nft: { capability: "none", commitment: "01" } } },
    { height: 0, tx_hash: "ee".repeat(32), tx_pos: 2, value: 87_603_187 },
  ];
  // Fulcrum lists confirmed history ascending, then the mempool (height 0, or -1 with unconfirmed parents).
  const history = [
    ...Array.from({ length: 12 }, (_, i) => ({ height: 335_000 + i, tx_hash: i.toString(16).padStart(64, "0") })),
    { height: -1, tx_hash: "f1".repeat(32), fee: 300 },
    { height: 0, tx_hash: "f2".repeat(32), fee: 250 },
  ];
  // get_history(scripthash, from_height?, to_height = -1): confirmed entries from `from_height`, plus the mempool.
  const electrum = (entries = history, tip = 335_370) =>
    stub({
      "blockchain.headers.get_tip": () => ({ height: tip, hex: "00" }),
      "blockchain.scripthash.get_balance": () => ({ confirmed: 87_607_187, unconfirmed: -1200 }),
      "blockchain.scripthash.listunspent": () => utxos,
      "blockchain.scripthash.get_history": (_sh, from = 0) => entries.filter((e) => e.height <= 0 || e.height >= Number(from)),
    });

  it("queries Electrum by the address's scripthash, with token data", async () => {
    const { rpc, calls } = electrum();
    await addressInfo(holder, rpc);
    expect(calls).toContainEqual({ method: "blockchain.scripthash.listunspent", params: [scripthash, "include_tokens"] });
    expect(calls.find((c) => c.method === "blockchain.scripthash.get_balance")?.params[0]).toBe(scripthash);
    expect(calls.find((c) => c.method === "blockchain.scripthash.get_history")?.params[0]).toBe(scripthash);
  });

  it("reports balances as decimal strings and aggregates tokens by category", async () => {
    const info = await addressInfo(holder, electrum().rpc);
    expect(info.address).toBe(holder);
    expect(info.network).toBe(NETWORK);
    expect(info.balance).toEqual({ confirmed: "87607187", unconfirmed: "-1200" });
    expect(info.utxoCount).toBe(5);
    expect(info.tokens).toEqual([
      { category: CAT_A, fungible: "0", nfts: 2 },
      { category: CAT_B, fungible: "9007199254741243", nfts: 1 }, // summed as bigint, beyond 2^53
    ]);
  });

  it("lists at most 10 recent transactions: mempool first, then by height descending", async () => {
    const info = await addressInfo(holder, electrum().rpc);
    expect(info.recent).toHaveLength(10);
    expect(info.recent.slice(0, 2).map((r) => r.height).sort()).toEqual([-1, 0]);
    expect(info.recent.slice(2).map((r) => r.height)).toEqual([335011, 335010, 335009, 335008, 335007, 335006, 335005, 335004]);
    expect(info.recent[2]).toEqual({ txid: (11).toString(16).padStart(64, "0"), height: 335011 });
  });

  it("asks only for recent blocks when they hold enough history (a busy address has 30k+ entries)", async () => {
    const busy = Array.from({ length: 40 }, (_, i) => ({ height: 335_000 + i, tx_hash: i.toString(16).padStart(64, "0") }));
    const { rpc, calls } = electrum(busy);
    const info = await addressInfo(holder, rpc);
    const historyCalls = calls.filter((c) => c.method === "blockchain.scripthash.get_history");
    expect(historyCalls).toEqual([{ method: "blockchain.scripthash.get_history", params: [scripthash, 335_370 - 1_000, -1] }]);
    expect(info.recent.map((r) => r.height)).toEqual(Array.from({ length: 10 }, (_, i) => 335_039 - i));
  });

  it("widens to the full history when recent blocks hold fewer than 10 entries", async () => {
    const sparse = [
      { height: 1_000, tx_hash: "01".repeat(32) },
      { height: 330_000, tx_hash: "02".repeat(32) },
      { height: 0, tx_hash: "03".repeat(32) },
    ];
    const { rpc, calls } = electrum(sparse);
    const info = await addressInfo(holder, rpc);
    expect(info.recent).toEqual([
      { txid: "03".repeat(32), height: 0 },
      { txid: "02".repeat(32), height: 330_000 },
      { txid: "01".repeat(32), height: 1_000 },
    ]);
    expect(calls.filter((c) => c.method === "blockchain.scripthash.get_history").at(-1)?.params).toEqual([scripthash]);
  });

  it("canonicalizes a token-aware address before reporting it", async () => {
    const info = await addressInfo(addr(NETWORK, hash20(1), "p2pkhWithTokens"), electrum().rpc);
    expect(info.address).toBe(holder);
  });

  it("rejects an address for the other network with a 400 before payment, without touching Electrum", async () => {
    const { rpc, calls } = electrum();
    const wrong = addr(OTHER, hash20(1));
    const err = await validateToolInput("bch-address", new URLSearchParams({ address: wrong }), { rpc }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err.status).toBe(400);
    expect(err.message).toContain(`address is for ${OTHER}`);
    expect(calls).toHaveLength(0);
    await expect(addressInfo(wrong, rpc)).rejects.toThrow(ToolInputError);
  });

  it("rejects a missing or malformed address with a 400 and accepts a valid one", async () => {
    const { rpc } = electrum();
    for (const params of [new URLSearchParams(), new URLSearchParams({ address: "not-an-address" })]) {
      const err = await validateToolInput("bch-address", params, { rpc }).catch((e) => e);
      expect(err).toBeInstanceOf(ToolInputError);
      expect(err.status).toBe(400);
    }
    await expect(validateToolInput("bch-address", new URLSearchParams({ address: holder }), { rpc })).resolves.toBeUndefined();
  });
});

describe("bch-tx", () => {
  const CATEGORY = "11".repeat(32);
  const tokenOwner = hash20(3);
  const parentBin = encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(7), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
    outputs: [
      { lockingBytecode: p2pkhBytecode(1), valueSatoshis: 10_000n },
      { lockingBytecode: p2pkhBytecode(2), valueSatoshis: 5_000n },
    ],
  });
  const parentId = hashTransaction(parentBin);
  const opReturn = Uint8Array.from([0x6a, 0x05, ...utf8ToBin("SC402"), 0x04, 0xde, 0xad, 0xbe, 0xef]);
  const childBin = encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [
      { outpointTransactionHash: hexToBin(parentId), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.from([0x51]) },
      { outpointTransactionHash: hexToBin(parentId), outpointIndex: 1, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.from([0x51]) },
    ],
    outputs: [
      { lockingBytecode: p2pkhBytecode(9), valueSatoshis: 9_000n },
      {
        lockingBytecode: Uint8Array.from([0x76, 0xa9, 0x14, ...tokenOwner, 0x88, 0xac]),
        valueSatoshis: 1_000n,
        token: { category: hexToBin(CATEGORY), amount: 500n, nft: { capability: "mutable", commitment: hexToBin("abcd") } },
      },
      { lockingBytecode: opReturn, valueSatoshis: 0n },
    ],
  });
  const childId = hashTransaction(childBin);

  const electrum = (opts: { parentMissing?: boolean; height?: number } = {}) =>
    stub({
      "blockchain.transaction.get": (txid) => {
        if (txid === childId) return binToHex(childBin);
        if (txid === parentId && !opts.parentMissing) return binToHex(parentBin);
        throw new Error(NOT_FOUND);
      },
      "blockchain.transaction.get_height": () => opts.height ?? 335_368,
      "blockchain.headers.get_tip": () => ({ height: 335_370, hex: "00" }),
    });

  it("decodes outputs (P2PKH, token, OP_RETURN), inputs, size, confirmations and the fee", async () => {
    const info = await txInfo(childId, electrum().rpc);
    expect(info.txid).toBe(childId);
    expect(info.height).toBe(335_368);
    expect(info.confirmations).toBe(3);
    expect(info.size).toBe(childBin.length);
    expect(info.fee).toBe("5000");
    expect(info.inputs).toEqual([
      { txid: parentId, vout: 0 },
      { txid: parentId, vout: 1 },
    ]);
    expect(info.outputs[0]).toEqual({ index: 0, value: "9000", address: addr(NETWORK, hash20(9)), type: "p2pkh", token: null, opReturn: null });
    expect(info.outputs[1]).toEqual({
      index: 1,
      value: "1000",
      address: addr(NETWORK, tokenOwner, "p2pkhWithTokens"),
      type: "p2pkh",
      token: { category: CATEGORY, amount: "500", nft: { capability: "mutable", commitment: "abcd" } },
      opReturn: null,
    });
    expect(info.outputs[2]).toEqual({
      index: 2,
      value: "0",
      address: null,
      type: "op_return",
      token: null,
      opReturn: { hex: binToHex(opReturn.slice(1)), text: "SC402" },
    });
  });

  it("reports an unconfirmed transaction with no height and 0 confirmations", async () => {
    const info = await txInfo(childId, electrum({ height: 0 }).rpc);
    expect(info.height).toBeNull();
    expect(info.confirmations).toBe(0);
  });

  it("returns fee: null when an input transaction cannot be fetched", async () => {
    const info = await txInfo(childId, electrum({ parentMissing: true }).rpc);
    expect(info.fee).toBeNull();
    expect(info.outputs).toHaveLength(3);
  });

  it("settles every parent fetch: a missing second parent while the first is pending leaves no unhandled rejection", async () => {
    const otherParentBin = encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(8), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: p2pkhBytecode(4), valueSatoshis: 2_000n }],
    });
    const otherParentId = hashTransaction(otherParentBin); // never served: the "missing" parent
    const twoParentsBin = encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        { outpointTransactionHash: hexToBin(parentId), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.from([0x51]) },
        { outpointTransactionHash: hexToBin(otherParentId), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.from([0x51]) },
      ],
      outputs: [{ lockingBytecode: p2pkhBytecode(9), valueSatoshis: 11_000n }],
    });
    const twoParentsId = hashTransaction(twoParentsBin);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { rpc } = stub({
        "blockchain.transaction.get": async (txid) => {
          if (txid === twoParentsId) return binToHex(twoParentsBin);
          if (txid === parentId) {
            await new Promise((r) => setTimeout(r, 20)); // the first parent is still pending…
            return binToHex(parentBin);
          }
          throw new Error(NOT_FOUND); // …when the second one fails
        },
        "blockchain.transaction.get_height": () => 335_368,
        "blockchain.headers.get_tip": () => ({ height: 335_370, hex: "00" }),
      });
      const info = await txInfo(twoParentsId, rpc);
      expect(info.fee).toBeNull();
      await new Promise((r) => setTimeout(r, 50)); // let Node report any rejection nobody handled
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects a malformed txid with a 400 before payment", async () => {
    const { rpc, calls } = electrum();
    for (const txid of ["xyz", "", childId.toUpperCase(), `${childId}00`]) {
      const err = await validateToolInput("bch-tx", new URLSearchParams({ txid }), { rpc }).catch((e) => e);
      expect(err).toBeInstanceOf(ToolInputError);
      expect(err.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("answers an unknown txid with a 404 before payment", async () => {
    const err = await validateToolInput("bch-tx", new URLSearchParams({ txid: "00".repeat(32) }), { rpc: electrum().rpc }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("transaction not found");
  });

  it("accepts a known txid", async () => {
    await expect(validateToolInput("bch-tx", new URLSearchParams({ txid: childId }), { rpc: electrum().rpc })).resolves.toBeUndefined();
  });

  it("does not report an Electrum outage as 'not found'", async () => {
    const down: Rpc = async () => {
      throw new Error("Electrum blockchain.transaction.get timed out");
    };
    const err = await validateToolInput("bch-tx", new URLSearchParams({ txid: childId }), { rpc: down }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ToolInputError);
  });
});

describe("Electrum time limit", () => {
  it("rejects a call that takes longer than the limit", async () => {
    const hang: Rpc = () => new Promise(() => {});
    await expect(withTimeout(hang, 20)("blockchain.headers.get_tip")).rejects.toThrow(/timed out/);
  });

  it("passes results through", async () => {
    await expect(withTimeout(async (m, ...p) => [m, ...p], 20)("a", 1)).resolves.toEqual(["a", 1]);
  });
});

describe("catalog", () => {
  it("appends the chain tools without moving existing provider indexes", () => {
    expect(TOOL_NAMES).toEqual(["crypto-price", "web-reader", "deep-analysis", "bch-address", "bch-tx"]);
    expect(TOOL_NAMES.map((n) => PAID_TOOLS[n].provider)).toEqual([0, 1, 2, 3, 4]);
    expect(PROVIDER_COUNT).toBe(5);
    expect(PAID_TOOLS["bch-address"].price).toBe(800n);
    expect(PAID_TOOLS["bch-tx"].price).toBe(500n);
    expect(Object.keys(PAID_TOOLS["bch-address"].params)).toEqual(["address"]);
    expect(Object.keys(PAID_TOOLS["bch-tx"].params)).toEqual(["txid"]);
  });

  it("a hosted vault allowlists only the hosted agent's tools by default; an external (MCP) vault all of them", () => {
    expect(HOSTED_AGENT_TOOLS).toEqual(["crypto-price", "web-reader", "deep-analysis"]);
    expect(TOOL_NAMES.filter((n) => defaultAllowed(n, false))).toEqual(["crypto-price", "web-reader", "deep-analysis"]);
    expect(TOOL_NAMES.filter((n) => defaultAllowed(n, true))).toEqual(TOOL_NAMES);
  });
});
