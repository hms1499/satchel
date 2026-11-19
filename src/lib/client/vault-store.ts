import { NETWORK } from "../config";
import { DescriptorSchema, type VaultDescriptor } from "../descriptor";

/** The parts of localStorage the store uses (injected in tests). */
export type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY = "satchel:vaults";
const OLD_KEY = "satchel:vault"; // single-vault storage before 2026-11-19

const browser = (): KV | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Same vault = same contract parameters (the contract address is a function of them). */
export function sameVault(a: VaultDescriptor, b: VaultDescriptor): boolean {
  const p = a.params;
  const q = b.params;
  return (
    a.network === b.network &&
    p.ownerPk === q.ownerPk &&
    p.agentPk === q.agentPk &&
    p.capPerPeriod === q.capPerPeriod &&
    p.periodBlocks === q.periodBlocks &&
    p.allowlist.length === q.allowlist.length &&
    p.allowlist.every((a, i) => a === q.allowlist[i])
  );
}

function read(kv: KV): VaultDescriptor[] {
  const raw: unknown = JSON.parse(kv.getItem(KEY) ?? "[]");
  const list = Array.isArray(raw) ? raw : [];
  return list.flatMap((d) => {
    const parsed = DescriptorSchema.safeParse(d);
    return parsed.success ? [parsed.data] : [];
  });
}

function write(kv: KV, list: VaultDescriptor[]) {
  kv.setItem(KEY, JSON.stringify(list));
}

/** Vaults this browser remembers for this network, newest first. Migrates the old single-vault key once. */
export function loadVaults(kv: KV | null = browser()): VaultDescriptor[] {
  if (!kv) return [];
  try {
    let list = read(kv);
    const old = kv.getItem(OLD_KEY);
    if (old) {
      const parsed = DescriptorSchema.safeParse(JSON.parse(old));
      if (parsed.success && !list.some((d) => sameVault(d, parsed.data))) list = [...list, parsed.data];
      write(kv, list);
      kv.removeItem(OLD_KEY);
    }
    return list.filter((d) => d.network === NETWORK);
  } catch {
    return [];
  }
}

/** Remembers a vault (replacing an older copy of the same vault), newest first. */
export function rememberVault(d: VaultDescriptor, kv: KV | null = browser()): void {
  if (!kv) return;
  try {
    write(kv, [d, ...read(kv).filter((x) => !sameVault(x, d))]);
  } catch {
    // Storage unavailable (private mode): the vault still works for this session.
  }
}

export function forgetVault(d: VaultDescriptor, kv: KV | null = browser()): void {
  if (!kv) return;
  try {
    write(kv, read(kv).filter((x) => !sameVault(x, d)));
  } catch {
    // ignore
  }
}
