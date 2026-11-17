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
 *
 * `sourceOutputToRelay` drops the WC2-BCH `contract` field, but wallets need it: Cashonize treats an input as a
 * contract input only when `contract.artifact.contractName` is present, and then signs over `contract.redeemScript`
 * and fills the signature placeholder in the provided unlocking bytecode. Without it the wallet signs the input
 * as P2PKH, which the node rejects for a covenant. So the contract info is added back (redeemScript as hex).
 */
export function toRelaySignRequest(wc: WcTransactionObject): RelaySignRequest {
  return {
    transaction: binToHex(encodeTransaction(wc.transaction)),
    sourceOutputs: wc.sourceOutputs.map((so) => ({
      ...sourceOutputToRelay(so as SourceOutput),
      ...(so.contract && {
        contract: {
          abiFunction: { name: so.contract.abiFunction.name, inputs: so.contract.abiFunction.inputs },
          redeemScript: binToHex(so.contract.redeemScript),
          artifact: { contractName: so.contract.artifact.contractName },
        },
      }),
    })),
    broadcast: wc.broadcast ?? false,
    ...(wc.userPrompt !== undefined && { userPrompt: wc.userPrompt }),
  };
}
