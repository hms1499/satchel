import { explorerTxUrl } from "./config";

/**
 * Mainnet evidence from `mcp/scripts/mainnet-e2e.mts` (2026-11-18, `E2E OK`): satchel-pay-mcp over stdio against a
 * Satchel server and the deployed example seller. Shown on the landing page and mirrored in README.md.
 */
export type ProofStep = { label: string; detail: string; txid?: string };

export const MAINNET_PROOF: readonly ProofStep[] = [
  {
    label: "Vault created",
    detail: "Covenant funded with a v2 recovery memo (seller and custom payee stored as hashes).",
    txid: "6d5d66cd74c7b07807b56e8741c91b957bd89a6075c0635c0dd89fd524a99ea6",
  },
  {
    label: "Direct payment",
    detail: "satchel_send: 1,000 sats to an allowlisted custom payee, with an on-chain memo.",
    txid: "ed2bfd4008fa9fac29cd0d96fe4b208b2ef563f052835f67d453635a51cfa515",
  },
  {
    label: "Paid API call",
    detail: "HTTP 402 → the agent pays 600 sats from the vault → Satchel's bch-tx tool answers.",
    txid: "dac2b6f5f40c87566aecf070dace7e0a3cb06333f8e90c6dbe6085ef88bd64d4",
  },
  {
    label: "Third-party seller",
    detail: "600 sats to an independent API built on satchel-pay-server (the example seller).",
    txid: "2ffc1c3c3a82a201889132b2ddebdafae4840004062ed3a5ab81d1ca68a74b37",
  },
  {
    label: "Over the cap: rejected",
    detail: "The next payment would pass the 5,000-sat cap. Every node refuses it at require(newSpent <= cap); nothing is spent.",
  },
  {
    label: "Owner withdraws",
    detail: "The owner key empties the vault and burns its state NFT. The agent key never could.",
    txid: "776945c28c5889a1ae4c3b8f46f02515e3649dcd3c4da4ef681a4d93c8f5e299",
  },
];

export const proofTxUrl = (txid: string) => explorerTxUrl("mainnet", txid);

export const LINKS = {
  seller: "https://satchel-example-seller.vercel.app",
  mcpNpm: "https://www.npmjs.com/package/satchel-pay-mcp",
  kitNpm: "https://www.npmjs.com/package/satchel-pay-server",
};
