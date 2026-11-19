import { ElectrumNetworkProvider, type Network, type NetworkProvider, type SpendableUtxo } from "cashscript";
import { ELECTRUM_HOSTS, isConnectionError } from "../../provider-kit/src/hosts";

export { ELECTRUM_HOSTS, isConnectionError };

/**
 * A CashScript NetworkProvider over several Electrum servers. It stays on the current server; on a connection-level
 * failure it moves to the next one and retries that call once. A node's answer (a rejected broadcast, an unknown
 * txid) is returned as is and never retried elsewhere.
 */
export class FailoverElectrumProvider implements NetworkProvider {
  private index = 0;
  private providers = new Map<string, ElectrumNetworkProvider>();

  constructor(
    readonly network: Network,
    private readonly hosts: readonly string[] = ELECTRUM_HOSTS[network as keyof typeof ELECTRUM_HOSTS] ?? [],
    private readonly make: (host: string) => ElectrumNetworkProvider = (host) => new ElectrumNetworkProvider(network, { hostname: host }),
  ) {
    if (hosts.length === 0) throw new Error(`no Electrum hosts for ${network}`);
  }

  private at(index: number): ElectrumNetworkProvider {
    const host = this.hosts[index];
    let p = this.providers.get(host);
    if (!p) this.providers.set(host, (p = this.make(host)));
    return p;
  }

  private async call<T>(fn: (p: ElectrumNetworkProvider) => Promise<T>): Promise<T> {
    const used = this.index;
    try {
      return await fn(this.at(used));
    } catch (e) {
      if (!isConnectionError(e) || this.hosts.length < 2) throw e;
      // Concurrent failures on the same host advance the index once, and a retry never lands on the host that failed.
      if (this.index === used) this.index = (used + 1) % this.hosts.length;
      const retry = this.index !== used ? this.index : (used + 1) % this.hosts.length;
      return fn(this.at(retry));
    }
  }

  getUtxos(address: string): Promise<SpendableUtxo[]> {
    return this.call((p) => p.getUtxos(address));
  }
  getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string): Promise<SpendableUtxo[]> {
    return this.call((p) => p.getUtxosForLockingBytecode(lockingBytecode));
  }
  getBlockHeight(): Promise<number> {
    return this.call((p) => p.getBlockHeight());
  }
  getRawTransaction(txid: string): Promise<string> {
    return this.call((p) => p.getRawTransaction(txid));
  }
  sendRawTransaction(txHex: string): Promise<string> {
    return this.call((p) => p.sendRawTransaction(txHex));
  }
  performRequest(method: string, ...params: Parameters<ElectrumNetworkProvider["performRequest"]>[1][]): Promise<unknown> {
    return this.call((p) => p.performRequest(method, ...params));
  }
}
