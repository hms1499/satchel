import type { ElectrumClient, ElectrumClientEvents } from "@electrum-cash/network";
import type { BchNetwork } from "./protocol";
import { ELECTRUM_HOSTS, isConnectionError } from "./hosts";
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
 * (default 10 s); a failed client constructor is not cached. Without `host`, it uses ELECTRUM_HOSTS[network] and, on a
 * connection-level failure, moves to the next server and retries the call once (a node's answer is never retried).
 */
export function electrumTransactionFetcher(network: BchNetwork, host?: string, timeoutMs = DEFAULT_TIMEOUT_MS): (txid: string) => Promise<string> {
  const hosts = host ? [host] : ELECTRUM_HOSTS[network];
  let index = 0;
  let client: Promise<ElectrumClient<ElectrumClientEvents>> | undefined;
  let clientIndex = -1;
  let connecting: Promise<void> | undefined;

  const fetchOnce = async (txid: string) => {
    if (client && clientIndex !== index) {
      // The host changed: close the old client (best effort) and connect to the current one.
      const old = client;
      client = undefined;
      connecting = undefined;
      old.then((c) => c.disconnect()).catch(() => {});
    }
    clientIndex = index;
    client ??= import("@electrum-cash/network")
      .then(({ ElectrumClient }) => new ElectrumClient("satchel-pay-server", ELECTRUM_PROTOCOL_VERSION, hosts[index]))
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

  return async (txid) => {
    const used = index;
    try {
      return await fetchOnce(txid);
    } catch (e) {
      if (hosts.length < 2 || !isConnectionError(e)) throw e;
      // Concurrent failures on the same host advance once; the retry uses the next host, never the failed one.
      if (index === used) index = (used + 1) % hosts.length;
      return fetchOnce(txid);
    }
  };
}
