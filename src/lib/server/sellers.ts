import { z } from "zod";
import type { SellerInfo } from "../allowlist";
import { normalizePayee } from "../payees";

export type { SellerInfo };

const SellerSchema = z.object({
  name: z.string().trim().min(1).max(32),
  origin: z.string().url().refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL"),
  payTo: z.string(),
  description: z.string().max(200),
});

/**
 * Suggested sellers for the create form, from `SATCHEL_SELLERS` (a JSON array of `{ name, origin, payTo, description }`).
 * A malformed value throws when the server starts, naming the variable, instead of silently showing no sellers.
 */
export function loadSellers(env: Record<string, string | undefined> = process.env): SellerInfo[] {
  const raw = env.SATCHEL_SELLERS?.trim();
  if (!raw) return [];
  const network = env.NEXT_PUBLIC_BCH_NETWORK === "mainnet" ? "mainnet" : "chipnet";
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("SATCHEL_SELLERS is not valid JSON: expected an array of { name, origin, payTo, description }");
  }
  const parsed = z.array(SellerSchema).max(8).safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`SATCHEL_SELLERS is invalid at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return parsed.data.map((s, i) => {
    const payTo = normalizePayee(s.payTo, network);
    if (!payTo.ok) throw new Error(`SATCHEL_SELLERS[${i}].payTo: ${payTo.error}`);
    return { ...s, payTo: payTo.address };
  });
}
