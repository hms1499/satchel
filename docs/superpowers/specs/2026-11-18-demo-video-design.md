# Satchel demo video — design (short)

## Intent

A 90–120 s video embedded in the DoraHacks BUIDL page so a BCH BLAZE judge understands Satchel in their ~2 minutes,
without waiting on 40–60 s wallet approvals. Audience: the three Mainnet Track judges only (not social, not Media Track).

- **Goals:** show the real product on BCH mainnet with a real WizardConnect wallet; make "the covenant stops a
  misbehaving agent" the climax; end with where to go next (live app, repo, MCP package).
- **Non-goals:** voiceover, music, social or Media Track cut, a vertical version.
- **Anti-goals:** dead time on wallet waits; anything that looks like a mockup; more than 2 minutes.

## Approaches

- **A. User screen-records the real flow, Claude edits (picked).** Real Cashonize and real mainnet txs, which the judges
  value most. Costs the user ~15 min and a few thousand sats (the deposit is withdrawn at the end).
- B. Slideshow of screenshots and slides: least effort, but reads as a mockup and hides Satchel's main strength.
- C. Claude records with Playwright: impossible for the wallet steps (WizardConnect needs the real wallet), so it
  would be A plus extra splicing.

## Decisions

- Narration: on-screen English captions only, no voice (Claude's call: judges read faster than they listen, and no
  recording needed).
- Captions are rendered as transparent PNGs from HTML (the local ffmpeg 8.1.2 has no `drawtext`/`subtitles`
  filters) and overlaid with ffmpeg `overlay`.
- Output: 1920×1080 MP4 (H.264, AAC silent track or none), ≤ 120 s, uploaded to YouTube as Unlisted and embedded with
  the editor's video button.
- Wallet waits are cut to ~1.5 s with an "Approved in wallet ✓" caption; the agent run is sped up ×2–3.

## Script

| t (s) | Shot | Caption |
| --- | --- | --- |
| 0–6 | Title card: `dorahacks-images/01-cover-1920x1080.png` | Satchel — give your AI agent a budget, not your keys. |
| 6–14 | Landing page, slow scroll to "Why this matters" | An agent with a normal wallet is one prompt injection away from being drained. |
| 14–24 | Launch app → Connect → WizardConnect QR → Cashonize approves (cut) | Connect any WizardConnect wallet. Here: Cashonize, BCH mainnet. |
| 24–40 | Create form: deposit 20,000, cap 8,000 / day, payees; the "What the covenant will enforce" box; Create → approve (cut) | The rules go into a BCH covenant, not our server: a cap per day and an allowlist of payees. |
| 40–62 | Run agent with the default prompt; events stream (402 → paid → tx); ×2–3 speed | The agent buys API calls on its own. Each call is a real mainnet transaction from the vault. |
| 62–80 | Try to break it: Overspend → rejected; Pay an attacker → rejected | A hijacked agent tries to overspend or pay an attacker. Every node rejects it. Balance unchanged. |
| 80–88 | Click one tx link → explorer page | All of it is on BCH mainnet. |
| 88–98 | Withdraw everything → approve (cut) → "Vault closed" | The owner can always pull everything out. |
| 98–110 | End card: live URL, repo, `npx -y satchel-pay-mcp`, `satchel-pay-server` | Try it: satchel-sigma.vercel.app |

## Recording brief (for the user)

- Production site https://satchel-sigma.vercel.app, mainnet, Cashonize with ≥ 25,000 sats.
- Chrome window full screen at 1920×1080 (or larger, it gets scaled), bookmarks bar hidden, one tab, zoom 110–125 % so
  text is readable; no notifications (Do Not Disturb).
- If Cashonize runs on the same screen, keep its approve dialog in frame; if on the phone, just keep recording.
- Record with QuickTime / ⌘⇧5 in one take; pauses and mistakes are fine, they get cut. Send the `.mov` path.
- Afterwards: `scripts/e2e.mts sweep` is not needed; tool payments go to Satchel's provider addresses, which hold
  the user's own seeds.

## Left to the builder (Claude)

Exact cut points, caption timing and styling (Satchel brand colors from `dorahacks-images/`), end-card layout.
