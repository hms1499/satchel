import { ElectrumNetworkProvider } from "cashscript";
import { NETWORK } from "../config";

let provider: ElectrumNetworkProvider | undefined;

export function getProvider(): ElectrumNetworkProvider {
  provider ??= new ElectrumNetworkProvider(NETWORK);
  return provider;
}
