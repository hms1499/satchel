# "Your vaults": find every open vault of the connected wallet (short design)

Date: 2026-11-19. Status: approved by the user.

**Why.** The user could not see an open v1 vault holding 20,000 sats and had to use a private window. Today the browser
remembers one vault (`satchel.vault` in localStorage). When it has one, the app opens that Dashboard and never lists
the wallet's other vaults. The chain scan runs only when nothing is remembered; it shows no progress and swallows
errors. Its results appear above the create form, where they are easy to miss. Since the v2 deploy, a remembered v1
descriptor opens an empty Dashboard with no way out. Judges get about 2 minutes, and finding your vault must not take
guesswork.

**Goals.** After connecting, the user always sees their open vaults or lands in the right one; scanning and its
failure are visible; creating a second vault never loses the first vault's agent token.
**Non-goals.** Server changes, covenant changes, listing withdrawn vaults (history).
**Anti-goals.** Showing the create form while the scan is still running (invites duplicate vaults); a dead-end screen.

**Approaches.** (1) A "Your vaults" hub with automatic routing (**chosen**). (2) Keep the single-vault flow and add a
banner "you have N other vaults". Rejected: a stale remembered vault still blocks the screen, and the user still has
to guess.

**Routing after the wallet connects** (the user approved this table):

| Wallet has | App shows |
| --- | --- |
| scan running | "Looking for your vaults…" (no create form yet) |
| 0 open vaults | create form |
| exactly 1 open vault | that vault's Dashboard |
| 2+ open vaults | "Your vaults" list (balance, cap, period, genesis link, Open), with "+ New vault" |
| scan failed | "Couldn't search your wallet — Retry" and "Create a new vault anyway" |

**Details.**
- **Open vaults** = what the chain scan finds (`findOwnedVaults`), merged with remembered descriptors that are still
  open on chain and whose `ownerPk` is the connected wallet's. Merging is by contract address. A remembered descriptor
  keeps its agent token, and the token wins over a recovered one.
- **Storage:** a list of descriptors (new key), migrating the old single key on first load. Remembered entries that
  are closed, from v1 (address not found), or owned by another wallet are not shown. They may be pruned.
- The Dashboard gets "← Your vaults" (back to the list, or to routing). The list has "+ New vault". After creating a
  vault, the app opens it. After a withdrawal, the app shows the "Vault closed" card, then routes as above.
- A vault without an agent token (recovered from chain) shows a "Withdraw only" label in the list.
- Not connected: unchanged (Landing / connect).

**Left to the builder:** component split, copy wording, whether to prune dead entries or just hide them, how to test
the routing (a pure `routeVaults(...)` function is recommended).
