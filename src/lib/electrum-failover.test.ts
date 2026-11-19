import { describe, expect, it, vi } from "vitest";
import type { ElectrumNetworkProvider } from "cashscript";
import { FailoverElectrumProvider, isConnectionError } from "./electrum-failover";

type Fake = { getBlockHeight: () => Promise<number>; sendRawTransaction: (hex: string) => Promise<string>; performRequest: (m: string, ...p: unknown[]) => Promise<unknown> };

function farm(behaviour: Record<string, Partial<Fake>>) {
  const made: string[] = [];
  const make = (host: string) => {
    made.push(host);
    const b = behaviour[host] ?? {};
    return {
      getBlockHeight: b.getBlockHeight ?? (async () => 100),
      sendRawTransaction: b.sendRawTransaction ?? (async () => "txid"),
      performRequest: b.performRequest ?? (async () => []),
    } as unknown as ElectrumNetworkProvider;
  };
  return { made, make };
}

const down = () => Promise.reject(new Error("Failed to establish connection: WebSocket: 1006: ."));

describe("FailoverElectrumProvider", () => {
  it("moves to the next host on a connection error and retries once", async () => {
    const { make } = farm({ a: { getBlockHeight: down }, b: { getBlockHeight: async () => 977_966 } });
    const p = new FailoverElectrumProvider("mainnet", ["a", "b"], make);
    expect(await p.getBlockHeight()).toBe(977_966);
  });

  it("stays on the host that worked for later calls", async () => {
    const aHeight = vi.fn(down);
    const { make } = farm({ a: { getBlockHeight: aHeight }, b: {} });
    const p = new FailoverElectrumProvider("mainnet", ["a", "b"], make);
    await p.getBlockHeight();
    await p.getBlockHeight();
    expect(aHeight).toHaveBeenCalledTimes(1);
  });

  it("passes a broadcast rejection through without trying another host", async () => {
    const rejection = new Error("the transaction was rejected by network rules.\n\nmandatory-script-verify-flag-failed (Script failed an OP_CHECKSEQUENCEVERIFY operation)");
    const bSend = vi.fn(async () => "txid");
    const { make } = farm({ a: { sendRawTransaction: () => Promise.reject(rejection) }, b: { sendRawTransaction: bSend } });
    const p = new FailoverElectrumProvider("mainnet", ["a", "b"], make);
    await expect(p.sendRawTransaction("00")).rejects.toBe(rejection);
    expect(bSend).not.toHaveBeenCalled();
  });

  it("throws the last error when every host fails", async () => {
    const { make } = farm({ a: { getBlockHeight: down }, b: { getBlockHeight: () => Promise.reject(new Error("Electrum request timed out")) } });
    const p = new FailoverElectrumProvider("mainnet", ["a", "b"], make);
    await expect(p.getBlockHeight()).rejects.toThrow(/timed out/);
  });

  it("forwards performRequest with failover", async () => {
    const { make } = farm({ a: { performRequest: down }, b: { performRequest: async (m) => [m] } });
    const p = new FailoverElectrumProvider("mainnet", ["a", "b"], make);
    expect(await p.performRequest("blockchain.scripthash.listunspent", "00")).toEqual(["blockchain.scripthash.listunspent"]);
  });
});

describe("isConnectionError", () => {
  it("connection-level failures", () => {
    for (const m of ["Failed to establish connection: WebSocket: 1006", "Electrum connect timed out after 10000 ms", "connect ECONNREFUSED 1.2.3.4:50004", "getaddrinfo ENOTFOUND x", "Connection closed", "socket hang up"]) {
      expect(isConnectionError(new Error(m))).toBe(true);
    }
  });
  it("node verdicts are not connection errors", () => {
    for (const m of ["mandatory-script-verify-flag-failed (x)", "non-BIP68-final", "missing-inputs", "txn-mempool-conflict", "dust", "bad-txns-in-belowout", "No such mempool or blockchain transaction"]) {
      expect(isConnectionError(new Error(m))).toBe(false);
    }
  });
});
