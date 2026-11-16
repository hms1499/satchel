export type BchNetwork = "mainnet" | "chipnet";

export const NETWORK: BchNetwork = process.env.NEXT_PUBLIC_BCH_NETWORK === "mainnet" ? "mainnet" : "chipnet";

export const EXPLORER_TX =
  NETWORK === "mainnet" ? "https://explorer.salemkode.com/tx/" : "https://chipnet.chaingraph.cash/tx/";

export const txUrl = (txid: string) => `${EXPLORER_TX}${txid}`;

/** Defaults shown when creating a vault (all in sats). */
export const DEFAULTS = {
  deposit: 20_000n,
  capPerPeriod: 8_000n,
  periodBlocks: 144n, // ~1 day
};

/** Hackathon banner links (required by BCH BLAZE rules). */
export const BANNER = {
  slides: process.env.NEXT_PUBLIC_SLIDES_URL ?? "#",
  repo: process.env.NEXT_PUBLIC_REPO_URL ?? "#",
  emberAddress: process.env.NEXT_PUBLIC_EMBER_ADDRESS ?? "",
};
