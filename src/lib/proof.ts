import { explorerTxUrl } from "./config";

/**
 * Mainnet evidence on covenant v2 from `mcp/scripts/mainnet-e2e.mts` (2026-11-19, `E2E OK`): satchel-pay-mcp over stdio against a
 * Satchel server and the deployed example seller. Shown on the landing page and mirrored in README.md.
 */
export type ProofStep = { label: string; detail: string; txid?: string };

export const MAINNET_PROOF: readonly ProofStep[] = [
  {
    label: "Vault created",
    detail: "Covenant funded with a v2 recovery memo (seller and custom payee stored as hashes).",
    txid: "78959aadfbf942a4bac390c829a01c4b555d41c4bc94e8b64e8eebeb2022d6ae",
  },
  {
    label: "Direct payment",
    detail: "satchel_send: 1,000 sats to an allowlisted custom payee, with an on-chain memo.",
    txid: "d01a66a13fb81d2ecb9bc6c6b4570e48f8395c89ec12d32f05c1c0a39a6013ac",
  },
  {
    label: "Paid API call",
    detail: "HTTP 402 → the agent pays 600 sats from the vault → Satchel's bch-tx tool answers.",
    txid: "cffcedab08be014d72bcbc11d582ff77bc0bff5d0440ec2b19762bf81e76388d",
  },
  {
    label: "Third-party seller",
    detail: "600 sats to an independent API built on satchel-pay-server (the example seller).",
    txid: "f03a01ec70df911986779c638959d84806eb2718fafa98787856fc0451f372b8",
  },
  {
    label: "Over the cap: rejected",
    detail: "The next payment would pass the 5,000-sat cap. Every node refuses it at require(newSpent <= cap); nothing is spent.",
  },
  {
    label: "New period too early: rejected",
    detail: "A new period needs the vault coin to be N blocks old. Before that, the node refuses it (non-BIP68-final).",
  },
  {
    label: "New period after the cooldown",
    detail: "Once the cooldown has passed, a new period is accepted and the spent counter restarts (separate run, N = 1 block).",
    txid: "31fcd404435c7c49ff78e6e868a5b9aded5cc08a556249e0cacb145294f5ecc6",
  },
  {
    label: "Owner withdraws",
    detail: "The owner key empties the vault and burns its state NFT. The agent key never could.",
    txid: "e684898a8d503537d3d73b2e8648e1d3e83159c6473d668531bc70197598dd71",
  },
];

export const proofTxUrl = (txid: string) => explorerTxUrl("mainnet", txid);

export const LINKS = {
  seller: "https://satchel-example-seller.vercel.app",
  mcpNpm: "https://www.npmjs.com/package/satchel-pay-mcp",
  kitNpm: "https://www.npmjs.com/package/satchel-pay-server",
};
