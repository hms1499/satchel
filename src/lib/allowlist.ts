import type { BchNetwork } from "./config";
import { normalizePayee } from "./payees";
import { MAX_RECOVERY_PAYLOAD, recoveryPayloadSize } from "./recovery";

/** A third-party seller suggested in the create form (from the server's `SATCHEL_SELLERS`). */
export type SellerInfo = { name: string; origin: string; payTo: string; description: string };

export type AllowlistResult =
  | { ok: true; allowlist: string[]; labels: Record<string, string>; sellers: string[] }
  | { ok: false; error: string };

const MAX_PAYEES = 8;
const MAX_LABEL = 32;

/**
 * The vault's allowlist from the create form: the chosen tools' payees, then the chosen sellers, then the custom
 * payees. Every address is stored in its canonical non-token form, so a `z…` address and its `q…` form are one payee.
 * Fails with a message for the form when a row is invalid, a payee is listed twice, or a limit is hit.
 */
export function buildAllowlist(input: {
  tools: string[];
  sellers: SellerInfo[];
  custom: { label: string; address: string }[];
  network: BchNetwork;
  knownPayees: string[];
}): AllowlistResult {
  const allowlist: string[] = [];
  const labels: Record<string, string> = {};

  const add = (address: string, what: string, label?: string): string | null => {
    const n = normalizePayee(address, input.network);
    if (!n.ok) return `${what}: ${n.error}.`;
    if (allowlist.includes(n.address)) return `${what}: this address is already in the list.`;
    allowlist.push(n.address);
    if (label !== undefined) labels[n.address] = label;
    return null;
  };

  for (const t of input.tools) {
    const err = add(t, "Tool payee");
    if (err) return { ok: false, error: err };
  }
  for (const s of input.sellers) {
    const err = add(s.payTo, `Seller "${s.name}"`, s.name);
    if (err) return { ok: false, error: err };
  }
  for (const [i, row] of input.custom.entries()) {
    const label = row.label.trim();
    const address = row.address.trim();
    if (!label && !address) continue; // an untouched new row
    const what = label ? `Custom payee "${label}"` : `Custom payee ${i + 1}`;
    if (!label || label.length > MAX_LABEL) return { ok: false, error: `${what}: give it a label of 1 to ${MAX_LABEL} characters.` };
    if (!address) return { ok: false, error: `${what}: enter an address.` };
    const err = add(address, what, label);
    if (err) return { ok: false, error: err };
  }

  if (allowlist.length === 0) return { ok: false, error: "Pick at least one payee the agent may pay." };
  if (allowlist.length > MAX_PAYEES) {
    return { ok: false, error: `A vault can pay at most ${MAX_PAYEES} payees; you picked ${allowlist.length}. Remove ${allowlist.length - MAX_PAYEES}.` };
  }
  const size = recoveryPayloadSize(allowlist, input.knownPayees);
  if (size > MAX_RECOVERY_PAYLOAD) {
    return {
      ok: false,
      error: `These custom payees don't fit in the on-chain recovery memo (${size} of ${MAX_RECOVERY_PAYLOAD} bytes), so the vault could not be recovered from the blockchain. Remove a custom payee or seller.`,
    };
  }
  return { ok: true, allowlist, labels, sellers: input.sellers.map((s) => s.origin) };
}
