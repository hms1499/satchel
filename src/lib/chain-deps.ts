/**
 * The chain libraries satchel-pay-mcp uses, re-exported from the shared code so there is one copy of each at runtime
 * and in tests (mcp/ has its own node_modules; importing "cashscript" directly from mcp/src would load a second copy
 * whose classes fail `instanceof` checks inside the shared modules).
 */
export { ElectrumNetworkProvider, SignatureTemplate, type NetworkProvider, type SpendableUtxo } from "cashscript";
export { FailoverElectrumProvider } from "./electrum-failover";
export { binToHex, hexToBin, secp256k1, validateSecp256k1PrivateKey } from "@bitauth/libauth";
