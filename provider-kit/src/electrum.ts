import type { ElectrumClient, ElectrumClientEvents } from "@electrum-cash/network";
import type { BchNetwork } from "./protocol";

/** The same default servers as CashScript's ElectrumNetworkProvider. */
const DEFAULT_HOSTS: Record<BchNetwork, string> = {
  mainnet: "bch.imaginary.cash",
  chipnet: "chipnet.bch.ninja",
};
const ELECTRUM_PROTOCOL_VERSION = "1.5.0";
const CONNECTED = 1; // ConnectionStatus.CONNECTED

/**
 * Fetches raw transactions (hex) from an Electrum server. The client is created and connected on the first call
 * (the library is loaded only then) and reused afterwards.
 */
export function electrumTransactionFetcher(network: BchNetwork, host?: string): (txid: string) => Promise<string> {
  let client: Promise<ElectrumClient<ElectrumClientEvents>> | undefined;
  let connecting: Promise<void> | undefined;

  return async (txid) => {
    client ??= import("@electrum-cash/network").then(
      ({ ElectrumClient }) => new ElectrumClient("satchel-pay-server", ELECTRUM_PROTOCOL_VERSION, host ?? DEFAULT_HOSTS[network]),
      (e: unknown) => {
        client = undefined; // let the next call try again
        throw e;
      },
    );
    const electrum = await client;
    if (electrum.status !== CONNECTED) {
      connecting ??= electrum.connect().finally(() => (connecting = undefined));
      await connecting;
    }
    const result = await electrum.request("blockchain.transaction.get", txid);
    if (result instanceof Error) throw result;
    if (typeof result !== "string") throw new Error("unexpected Electrum response");
    return result;
  };
}
