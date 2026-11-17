import { binToHex, encodeTransaction } from "@bitauth/libauth";
import { sourceOutputToRelay, type SourceOutput } from "@wizardconnect/core/hdwalletv1-serialize";
import type { TransactionBuilder } from "cashscript";

type WcTransactionObject = ReturnType<TransactionBuilder["generateWcTransactionObject"]>;

export interface RelaySignRequest {
  transaction: string; // hex-encoded unsigned transaction
  sourceOutputs: unknown[]; // relay JSON: hex bytes, `<bigint: Xn>` amounts
  broadcast: boolean;
  userPrompt?: string;
}

/**
 * WizardConnect sends sign requests through a relay with plain `JSON.stringify`, so the CashScript
 * WalletConnect object (bigints, Uint8Arrays) must first be converted to the relay format the wallet
 * parses: the transaction as hex and each source output via WizardConnect's own `sourceOutputToRelay`.
 */
export function toRelaySignRequest(wc: WcTransactionObject): RelaySignRequest {
  return {
    transaction: binToHex(encodeTransaction(wc.transaction)),
    sourceOutputs: wc.sourceOutputs.map((so) => sourceOutputToRelay(so as SourceOutput)),
    broadcast: wc.broadcast ?? false,
    ...(wc.userPrompt !== undefined && { userPrompt: wc.userPrompt }),
  };
}
