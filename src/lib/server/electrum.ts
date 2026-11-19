import { NETWORK } from "../config";
import { FailoverElectrumProvider } from "../electrum-failover";

let provider: FailoverElectrumProvider | undefined;

/** Electrum for the server, with failover across ELECTRUM_HOSTS (provider-kit/src/hosts.ts). */
export function getProvider(): FailoverElectrumProvider {
  provider ??= new FailoverElectrumProvider(NETWORK);
  return provider;
}
