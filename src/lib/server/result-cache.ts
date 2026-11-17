import { ResultCache } from "../../../provider-kit/src/index";

export { ResultCache };

/** Paid tool results by challenge nonce (per instance), shared with the paywall in `api/tools/[tool]`. */
export const paidResults = new ResultCache<unknown>();
