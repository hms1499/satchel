import { decodeCashAddress } from "@bitauth/libauth";
import type { BchNetwork } from "satchel-pay-server";

const PREFIX: Record<BchNetwork, string> = { mainnet: "bitcoincash", chipnet: "bchtest" };

export function loadSellerEnv(env: Record<string, string | undefined>): { network: BchNetwork; payTo: string; secret: string | undefined } {
  const rawNetwork = (env.SELLER_NETWORK ?? "").trim();
  const network = rawNetwork === "" ? "mainnet" : rawNetwork;
  if (network !== "mainnet" && network !== "chipnet") {
    throw new Error(`SELLER_NETWORK must be "mainnet" or "chipnet" (got "${rawNetwork}")`);
  }
  const payTo = (env.SELLER_PAY_TO ?? "").trim();
  if (payTo === "") throw new Error("SELLER_PAY_TO is required: set it to your CashAddr");
  const decoded = decodeCashAddress(payTo);
  if (typeof decoded === "string") throw new Error(`SELLER_PAY_TO is not a valid CashAddr: ${decoded}`);
  if (decoded.prefix !== PREFIX[network]) {
    throw new Error(`SELLER_PAY_TO has prefix "${decoded.prefix}" but SELLER_NETWORK is ${network} (expected "${PREFIX[network]}")`);
  }
  return { network, payTo, secret: env.SELLER_SECRET };
}
