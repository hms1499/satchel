import type { VaultDescriptor } from "../descriptor";
import { sameVault } from "./vault-store";

/** An open vault of the connected wallet. `withdrawOnly`: no agent token (recovered from chain), the agent can't run. */
export type OpenVault = { descriptor: VaultDescriptor; balance: bigint; withdrawOnly: boolean };

/**
 * The wallet's open vaults: what the chain scan found, plus remembered vaults of this owner the scan missed but that are
 * still open (`balanceOf` > 0). A remembered copy's agent token wins. Largest balance first.
 */
export async function mergeVaults(
  scanned: { descriptor: VaultDescriptor; balance: bigint }[],
  remembered: VaultDescriptor[],
  ownerPk: string,
  balanceOf: (d: VaultDescriptor) => Promise<bigint | null>,
): Promise<OpenVault[]> {
  const mine = remembered.filter((d) => d.params.ownerPk === ownerPk);
  const out: OpenVault[] = scanned.map(({ descriptor, balance }) => {
    const known = mine.find((d) => sameVault(d, descriptor));
    const d = known?.token ? { ...descriptor, ...known } : descriptor;
    return { descriptor: d, balance, withdrawOnly: !d.token };
  });
  const missed = mine.filter((d) => !scanned.some((s) => sameVault(s.descriptor, d)));
  const balances = await Promise.all(missed.map((d) => balanceOf(d).catch(() => null)));
  missed.forEach((d, i) => {
    const balance = balances[i];
    if (balance !== null && balance > 0n) out.push({ descriptor: d, balance, withdrawOnly: !d.token });
  });
  return out.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
}

export type Route =
  | { screen: "scanning" }
  | { screen: "create" }
  | { screen: "dashboard"; vault: OpenVault }
  | { screen: "list" }
  | { screen: "scan-failed" };

/** Which screen to show once the wallet is connected (the table in the "Your vaults" design). */
export function routeVaults(o: { scan: "pending" | "done" | "failed"; open: OpenVault[]; wantsCreate: boolean; chosen: VaultDescriptor | null }): Route {
  const chosen = o.chosen ? o.open.find((v) => sameVault(v.descriptor, o.chosen!)) : undefined;
  if (chosen) return { screen: "dashboard", vault: chosen };
  if (o.wantsCreate) return { screen: "create" };
  if (o.scan === "pending") return { screen: "scanning" };
  if (o.scan === "failed") return { screen: "scan-failed" };
  if (o.open.length === 0) return { screen: "create" };
  if (o.open.length === 1) return { screen: "dashboard", vault: o.open[0] };
  return { screen: "list" };
}
