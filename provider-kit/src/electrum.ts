import type { ElectrumClient, ElectrumClientEvents } from "@electrum-cash/network";
import type { BchNetwork } from "./protocol";

/** The same default servers as CashScript's ElectrumNetworkProvider. */
const DEFAULT_HOSTS: Record<BchNetwork, string> = {
  mainnet: "bch.imaginary.cash",
  chipnet: "chipnet.bch.ninja",
};
const ELECTRUM_PROTOCOL_VERSION = "1.5.0";
const CONNECTED = 1; // ConnectionStatus.CONNECTED
const DEFAULT_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fetches raw transactions (hex) from an Electrum server. The client is created and connected on the first call
 * (the library is loaded only then) and reused afterwards. Connecting and each request time out after `timeoutMs`
 * (default 10 s); a failed client constructor is not cached.
 */
export function electrumTransactionFetcher(network: BchNetwork, host?: string, timeoutMs = DEFAULT_TIMEOUT_MS): (txid: string) => Promise<string> {
  let client: Promise<ElectrumClient<ElectrumClientEvents>> | undefined;
  let connecting: Promise<void> | undefined;

  return async (txid) => {
    client ??= import("@electrum-cash/network")
      .then(({ ElectrumClient }) => new ElectrumClient("satchel-pay-server", ELECTRUM_PROTOCOL_VERSION, host ?? DEFAULT_HOSTS[network]))
      .catch((e: unknown) => {
        client = undefined; // import or constructor failed: let the next call try again
        throw e;
      });
    const electrum = await client;
    if (electrum.status !== CONNECTED) {
      connecting ??= electrum.connect().finally(() => (connecting = undefined));
      await withTimeout(connecting, timeoutMs, "Electrum connect");
    }
    const result = await withTimeout(electrum.request("blockchain.transaction.get", txid), timeoutMs, "Electrum request");
    if (result instanceof Error) throw result;
    if (typeof result !== "string") throw new Error("unexpected Electrum response");
    return result;
  };
}
