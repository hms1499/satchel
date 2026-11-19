# Your Vaults UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the wallet connects, show every open vault it owns (or land in the only one), with visible scanning and errors, and remember several vaults per browser without losing agent tokens.

**Architecture:** Three pure, tested pieces feed the UI: a multi-vault store (localStorage), `mergeVaults` (chain scan + remembered descriptors), and `routeVaults` (which screen to show). `SatchelApp` uses them; a new `VaultList` component renders the list; Dashboard gets a back link.

**Tech Stack:** Next.js 16 / React 19 client components, vitest (node environment: storage is injected).

**Spec:** `docs/superpowers/specs/2026-11-19-your-vaults-ux-design.md`

## Global Constraints

- No server or covenant changes. UI copy is in English.
- New storage key `satchel:vaults` (JSON array of descriptors). Migrate the old key `satchel:vault` once, then remove it.
- All storage access is wrapped in try/catch (private mode); the app works without storage.
- The routing table in the spec is binding: scanning → no create form; 0 → create; 1 → that Dashboard; 2+ → list; failed → Retry + "Create a new vault anyway".
- `?agent=<pubkey>` links (satchel-pay-mcp) always route to the create form; the list stays reachable via "← Your vaults".

## Review Focus

1. The old single-key descriptor is a v1 vault (not open on chain): it must not open a Dashboard; it is dropped from the open list.
2. A remembered descriptor whose `ownerPk` differs from the connected wallet's: hidden, never merged.
3. The scan finds a vault the browser also remembers: one entry, carrying the remembered token.
4. The user disconnects or switches wallets mid-scan: results for the old wallet must not be shown for the new one.
5. Withdrawing the only vault: "Vault closed" card, then routing shows the create form (0 vaults), not a stale list.

---

### Task 1: Multi-vault store

**Files:** Create `src/lib/client/vault-store.ts`, test `src/lib/client/vault-store.test.ts`. Modify `src/lib/client/agent.ts` (remove `loadDescriptor`/`saveDescriptor` after Task 3 stops using them).

**Interfaces (produces):**
- `type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">`
- `loadVaults(kv?: KV): VaultDescriptor[]` migrates `satchel:vault` into the list (once, then removes it), keeps only well-formed entries (`DescriptorSchema.safeParse`) for `NETWORK`
- `rememberVault(d: VaultDescriptor, kv?: KV): void` upserts by `params` identity (same ownerPk, agentPk, cap, period, allowlist), newest first
- `forgetVault(d: VaultDescriptor, kv?: KV): void`

- [ ] **Step 1:** Tests: migration of the old key (then the old key is gone); remembering two vaults keeps both, with their tokens; remembering the same vault again replaces it without duplicating; a malformed entry is dropped; a throwing storage returns `[]` and does not throw.
- [ ] **Step 2:** Run `npx vitest run src/lib/client/vault-store.test.ts` and expect FAIL. Implement. Run again and expect PASS.
- [ ] **Step 3:** Commit `feat(ui): remember several vaults per browser`.

### Task 2: mergeVaults and routeVaults

**Files:** Create `src/lib/client/vault-routing.ts`, test `src/lib/client/vault-routing.test.ts`.

**Interfaces (produces):**
- `type OpenVault = { descriptor: VaultDescriptor; balance: bigint; withdrawOnly: boolean }`
- `mergeVaults(scanned: { descriptor: VaultDescriptor; balance: bigint }[], remembered: VaultDescriptor[], ownerPk: string, balanceOf: (d: VaultDescriptor) => Promise<bigint | null>): Promise<OpenVault[]>`. Identity is the `params` identity from Task 1. A scanned entry takes the remembered token if there is one. Remembered entries with this `ownerPk` that the scan missed are kept only if `balanceOf` returns a value > 0. `withdrawOnly = !token`. Sorted by balance, descending.
- `type Route = { screen: "scanning" } | { screen: "create" } | { screen: "dashboard"; vault: OpenVault } | { screen: "list" } | { screen: "scan-failed" }`
- `routeVaults(o: { scan: "pending" | "done" | "failed"; open: OpenVault[]; wantsCreate: boolean; chosen: VaultDescriptor | null }): Route`. Order: `chosen` (if it is in `open`) → dashboard; `wantsCreate` → create; pending → scanning; failed → scan-failed; then 0 → create, 1 → dashboard, 2+ → list.

- [ ] **Step 1:** Tests: every row of the spec table; the `?agent=` case (`wantsCreate`) beats a single vault; `chosen` not in `open` is ignored. Review Focus 1–3: a v1 remembered entry (`balanceOf` → null) is dropped; another owner's entry is dropped without calling `balanceOf`; scan + remembered of the same vault → one entry with the token.
- [ ] **Step 2:** Run `npx vitest run src/lib/client/vault-routing.test.ts` and expect FAIL. Implement. Run again and expect PASS.
- [ ] **Step 3:** Commit `feat(ui): merge scanned and remembered vaults; route after connect`.

### Task 3: UI wiring

**Files:** Create `src/components/VaultList.tsx`. Modify `src/components/SatchelApp.tsx`, `src/components/Dashboard.tsx` (prop `onBack?: () => void`, rendered as "← Your vaults").

- `SatchelApp` state: `scan` ("pending" | "done" | "failed"), `open: OpenVault[]`, `chosen: VaultDescriptor | null`, `wantsCreate` (true when `?agent=` is set or the user pressed "+ New vault" / "Create a new vault anyway"). The scan starts when the wallet connects and on "Retry". It is keyed by the owner address: results that arrive for a previous wallet are discarded (Review Focus 4).
- Not connected: if storage holds vaults, open the most recent as before (the Dashboard works without the wallet for the agent). Otherwise show the existing connect card.
- After create: `rememberVault`, set `chosen` to the new vault, add it to `open`. After withdraw: `forgetVault`, remove it from `open`, show the "Vault closed" card. Its button "Continue" clears `closed` and `chosen`, and routing takes over (Review Focus 5).
- `VaultList` copy: title "Your vaults", per row "{balance} sats · cap {cap} per {period noun} · created {genesis link}", a "Withdraw only" chip when `withdrawOnly`, an "Open" button, and "+ New vault" at the top. Scanning: "Looking for your vaults…" with a spinner. Failed: "Couldn't search your wallet." with "Retry" and "Create a new vault anyway".
- [ ] **Step 1:** Implement. Run `npm run typecheck`, `npm run lint` and `npm test`. Expected: clean.
- [ ] **Step 2:** Run `npm run build`. Expected: success.
- [ ] **Step 3:** Commit `feat(ui): Your vaults list, scan status, back link`.
- [ ] **Step 4:** Ask the user before pushing to main (production deploy), then check the deploy with `vercel ls`/`vercel inspect` and ask the user to retest connect → list/auto-open → withdraw with Cashonize.
