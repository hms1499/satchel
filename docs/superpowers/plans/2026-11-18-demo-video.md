# Satchel Demo Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the user's one-take screen recording into a ≤ 120 s captioned 1080p demo video for the DoraHacks BUIDL page.

**Architecture:** Captions and the title/end cards are HTML rendered to PNG with Playwright (transparent PNGs for captions). A
small Python script reads an edit list (`edl.json`), cuts and speeds up segments of the recording with ffmpeg, overlays the
caption PNGs, and concatenates everything with the cards. Tasks 1–2 are done before the recording arrives; Task 3 needs it.

**Tech Stack:** ffmpeg 8.1.2 (no `drawtext`/`subtitles`, so captions use `overlay`), Python 3 stdlib, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-11-18-demo-video-design.md`

## Global Constraints

- Working folder: `/Users/vanhuy/Desktop/BCH-BLAZE/demo-video/` (outside the git repo; recordings and renders are not committed).
- Output: `demo-video/out/satchel-demo.mp4`, 1920×1080, 30 fps CFR, H.264 `yuv420p`, `+faststart`, silent AAC track, ≤ 120 s.
- Captions: English, text exactly as in the spec's Script table; wallet waits cut to ≤ 1.5 s with the caption "Approved in wallet ✓".
- Brand: background `#f5f6f2`, ink `#111614`, green `#04704F`, accent `#0AC18E`, amber `#f5b97a`; fonts Space Grotesk
  (headings), Inter (body), JetBrains Mono (code), from Google Fonts.

## Review Focus

1. A Retina recording (e.g. 2880×1800, 16:10) must be scaled and padded to 1920×1080 with `#f5f6f2`, never stretched.
2. QuickTime writes variable frame rate; every segment is normalized to 30 fps CFR before concat so cuts don't drift.
3. Captions over a light UI must stay readable: dark `#111614` pill at ~92 % opacity, white text, bottom-centered, 48 px margin.
4. A recording with a mic/system audio track must not leak audio: input audio is dropped, a silent track is generated.
5. Personal or distracting content in frame (macOS notifications, other tabs, seed phrases) is checked on the contact sheet in Task 3 and cut.

---

### Task 1: Caption and card renderer

**Files:**
- Create: `demo-video/captions.json` — `{ "<id>": "<text>" }` for ids `problem`, `connect`, `create`, `agent`, `attack`, `explorer`, `withdraw`, `approved` (texts from the spec Script table; `approved` = "Approved in wallet ✓").
- Create: `demo-video/cards.html` — `?caption=<id>` renders one caption pill on a transparent 1920×1080 page; `?card=title` and `?card=end` render full cards.
- Output: `demo-video/out/cap-<id>.png`, `demo-video/out/card-title.png`, `demo-video/out/card-end.png`.

**Interfaces:**
- Produces: caption PNGs (1920×1080 RGBA, pill bottom-centered) and card PNGs (1920×1080), named as above.

- [ ] **Step 1:** Title card = `dorahacks-images/01-cover-1920x1080.png` re-rendered as-is (copy to `out/card-title.png`). End card: Satchel logo + "Try it on BCH mainnet", `satchel-sigma.vercel.app`, `github.com/hms1499/satchel`, `npx -y satchel-pay-mcp`, `npm i satchel-pay-server`, in the cover's style.
- [ ] **Step 2:** Render every PNG with Playwright at viewport 1920×1080, `omitBackground: true` for captions.
- [ ] **Step 3: Verify**
  Run: `for f in demo-video/out/*.png; do ffprobe -v error -select_streams v -show_entries stream=width,height,pix_fmt -of csv=p=0 "$f"; done`
  Expected: every line `1920,1080,rgba` (cards may be `rgb24`/`rgba`). Then view `cap-attack.png` and `card-end.png`: text fits on one or two lines, nothing clipped.

### Task 2: Edit pipeline

**Files:**
- Create: `demo-video/build.py` — `python3 build.py <recording> <edl.json> <out.mp4>`.
- Create: `demo-video/test_build.py` — builds a synthetic recording and asserts on the output.

**Interfaces:**
- Consumes: Task 1 PNGs in `demo-video/out/`.
- Produces: `edl.json` format, a list of items, each one of
  `{"card": "title"|"end", "dur": float}` or
  `{"in": float, "out": float, "speed": float = 1, "caption": "<id>"|null}` (times in seconds of the source recording).
  Output duration = Σ card `dur` + Σ (`out` − `in`) / `speed`.

- [ ] **Step 1: Write the failing test** `test_build.py`: create `tmp/test.mov` with `ffmpeg -f lavfi -i testsrc2=size=2880x1800:rate=60 -f lavfi -i sine -t 40` (16:10, 60 fps, with audio); EDL = title 3 s, `{in:2,out:8,caption:"connect"}`, `{in:10,out:31,speed:3,caption:"agent"}`, `{in:32,out:33.5,caption:"approved"}`, end 4 s. Assert with ffprobe: duration within ±0.2 s of 3+6+7+1.5+4 = 21.5; video 1920×1080, `h264`, `yuv420p`, `30/1`; one audio stream, and its mean volume (`volumedetect`) ≤ −90 dB.
- [ ] **Step 2:** Run `python3 demo-video/test_build.py` → FAIL (no `build.py`).
- [ ] **Step 3: Implement `build.py`.** Per item, render an intermediate segment: cards with `-loop 1 -t dur`; recording segments with `-ss in -to out`, `setpts=PTS/speed`, `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#f5f6f2`, `fps=30`, caption PNG via `overlay`; all with `-an`, then concat (demuxer, same codec params), add `anullsrc` silent AAC, `-shortest`, `-movflags +faststart`.
- [ ] **Step 4:** Run `python3 demo-video/test_build.py` → PASS. View one frame at t=12 s of the output: caption pill readable, no stretching.

### Task 3: Cut the real recording (after the user sends the `.mov`)

**Files:**
- Create: `demo-video/edl.json`, `demo-video/out/contact-*.jpg`
- Output: `demo-video/out/satchel-demo.mp4`

- [ ] **Step 1:** Contact sheet: `ffmpeg -i <rec> -vf "fps=1/2,scale=480:-1,tile=6x5" demo-video/out/contact-%02d.jpg`; view the sheets, note the timestamp of each spec scene, each wallet wait, and anything from Review Focus #5.
- [ ] **Step 2:** Write `edl.json` following the spec Script order and timings; agent run at speed 2–3; each wallet wait trimmed to ≤ 1.5 s with caption `approved`.
- [ ] **Step 3:** `python3 demo-video/build.py <rec> demo-video/edl.json demo-video/out/satchel-demo.mp4`; check duration ≤ 120 s with ffprobe.
- [ ] **Step 4:** Extract one frame per scene and view them: caption matches the shot, the attack rejection text is visible, no personal data in frame. Fix the EDL and rebuild if not.
- [ ] **Step 5:** Hand the path to the user with upload steps (YouTube, Unlisted, then the editor's 🎬 button on DoraHacks).
