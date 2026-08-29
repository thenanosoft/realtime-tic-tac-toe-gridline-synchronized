# UI/UX Audit — current build

Findings from reading `app/globals.css` (1122 lines) and the components in
`app/components/`. Each entry gives the root cause, not just the symptom. Task IDs map
to [TODO.md](./TODO.md).

Severity: **S1** breaks the experience · **S2** clearly noticeable · **S3** polish

**Status after Phase 1:** S1-A, S1-B, S2-A, S2-B, S2-C, S2-D and S2-F are fixed and covered by
regression tests in `tests/styles.test.ts`. S2-E was investigated and withdrawn — it was not a
real defect. S1-C is deliberately deferred to Phase 11, where the reduced-motion state is
designed alongside the accessibility pass. The S3 items remain open.

---

## S1-A — The board rearranges itself as the game is played · `P1-01`

**Reported as:** "gridline jab game khel rahe hote hain to fixed nahi rehti; jab sab holes
fill ho jate hain tab fully arranged hoti hai."

**Root cause.** `app/globals.css:641-655`:

```css
.game-board {
  display: grid;
  grid-template-columns: repeat(3, 1fr);   /* columns only */
  aspect-ratio: 1;
  background: linear-gradient(90deg, … 33.15% … 66.75% …),  /* painted gridlines */
              linear-gradient(0deg,  … 33.15% … 66.75% …);
}
```

There is **no `grid-template-rows`**. The three rows are therefore implicit `auto` tracks.
An empty cell contains only absolutely-positioned children (`.ghost-symbol` is
`position: absolute`), so its content height is **0**. A filled cell contains
`.drawn-x` / `.drawn-o`, which are also absolutely positioned or percentage-sized — but the
cell's `display: grid; place-items: center` still resolves differently once a child exists.

The board has a definite height from `aspect-ratio: 1`, so the leftover space is distributed
by `align-content: normal` (which behaves as `stretch`) — and stretch splits the **surplus
equally across the auto tracks**, not proportionally. A row containing content therefore ends
up taller than an empty row. As marks land, the row heights change; when all nine are filled
the three rows are equal again and everything finally lines up.

Meanwhile the painted gridlines are fixed percentages of the *board background* and never
move. So the visible lines and the actual cell boundaries drift apart mid-match.

**Fix.**
1. `grid-template-rows: repeat(3, 1fr)` on `.game-board` (`P1-01`).
2. Stop painting gridlines as a background gradient. Derive them from the cells themselves
   so the two can never disagree again (`P1-03`).
3. Lock it down with a test that measures cell bounding boxes at 0, 5 and 9 marks (`P1-02`).

---

## S1-B — Text is unreadable, down to 5px · `P1-04` `P1-05`

69 font declarations in `globals.css` fall between 4px and 11px. The worst offenders are
mobile, where the *smallest* text is the identity and state information a player most needs:

| Selector | Size | Line |
| --- | --- | --- |
| `.player-label` | **5px** | 1040 |
| `.room-kicker` | **5px** | 1047 |
| `.player-slot` | **5px** | 1058 |
| `.you-tag` | **5px** | 1059 |
| `.player-state` | **5px** | 1066 |
| `.board-meta` | **5px** | 1070 |
| `.presence` | 6px | 1065 |
| `.chat-toggle b` | 6px | 1106 |
| `.copy-room`, `.chat-toggle`, `.leave-room` | 7px | 1050-1052 |
| `.status-copy p` | 7px | 1079 |
| `.connection-badge` | 8px | 1029 |
| `.composer-input textarea` | 9px | 890 |

Desktop is better but still lands at 6px (`.board-meta`, line 640) and 7px
(`.countdown-overlay small`, `.move-pending`).

**Root cause.** No type scale exists. Every size is an independent hand-tuned pixel value,
so there was never a floor to violate.

**Fix.** Introduce `--text-*` custom properties with a fluid `clamp()` scale, floor 12px for
anything a user reads, 11px reserved for genuinely decorative monospace tickers. Then migrate
section by section — the file is large and hand-tuned, so a single sweeping replace would
break spacing.

**Related, and its own bug:** the chat textarea at **9px** (line 890) also triggers iOS
Safari's automatic zoom-on-focus, because Safari zooms any input under 16px. The composer
should be 16px on touch viewports regardless of the visual scale chosen.

---

## S1-C — Reduced motion is a kill switch, not a design · `P11-03`

`globals.css:1114-1121` is the copy-paste blanket:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
  }
}
```

This is exactly the outcome the brief rules out. Everything snaps: the countdown, the
X stroke draw, the O arc, the winning line, the reaction float. The product reads as broken
rather than calm. Reduced motion needs a designed alternative — opacity crossfades and clear
state changes with no positional movement — not a global duration override.

---

## S2-A — Labels hidden with `font-size: 0` · `P1-06`

`globals.css:1028` and `:1104` collapse `.sound-toggle` and `.chat-toggle` to `font-size: 0`
on mobile to hide their text. The accessible name survives (`aria-label` is present on some,
not all), but this is a fragile pattern: the sound toggle has no `aria-label` visible in the
component and depends entirely on text that is now zero-sized. Convert these to real icon
buttons with explicit accessible names.

## S2-B — Mobile tap targets below the 44px minimum · `P1-07`

`.copy-room`, `.chat-toggle`, `.leave-room` are 31px tall on mobile (lines 1050-1054);
`.composer-tools > button` is 25-27px wide (1088, 1109); `.chat-send` is 34-36px.
All are below the 44×44 guideline, and the leave-room button is a destructive action.

## S2-C — No landscape layout at all · `P1-11` `P11-05`

There is no `@media (orientation: landscape)` rule anywhere in the file. On 667×375 the room
uses `min-height: calc(100svh - 64px)` (line 1045) with a board sized
`min(610px, calc(100svh - 470px))` (line 980) — at 375px of viewport height that computes to a
negative value, so the board collapses to its minimum and the arena clips.

## S2-D — Layout shift during play · `P1-08`

`.move-pending` (line 744) is absolutely positioned so it does not shift the board — good.
But `.game-status` only sets `min-height: 76px` (line 749) while `.status-copy p` wraps
variable-length text, and `.rematch-button` appears and disappears between phases. Status text
changing length nudges the surrounding layout. Reserve the space explicitly.

## ~~S2-E — Diagonal winning lines are clipped~~ · **WITHDRAWN, not a defect** · `P1-09`

This finding was wrong and is retained here rather than deleted, because a withdrawn finding
is part of the record.

The claim was that `overflow: hidden` on `.game-board` clips the 45°/135° winning lines. Working
the geometry through: the line is `width: 119%`, `transform-origin: left center`, anchored at
`left: 8%; top: 8%`. Rotating by 45° puts the far end at
`0.08S + 1.19S·cos45° = 0.9214S` on both axes, for a board of side `S`. That is inside the
`0…S` box, with room to spare — and the 18px glow at a 600px board reaches 570px, still inside.

The diagonals were never clipped. No change was made.

## S2-F — Contrast failures · `P1-13`

The original entry blamed `--dim: #5c5e5d`. That token turns out to be **declared but never
used** (so is `--muted`), so it was not the problem — a reminder that reading a token block is
not the same as reading the rules.

The real failures were the literal hex values, and they were found by computing every ratio
rather than by eye. Measured against `#101216` — the raised panel tone, which is the lighter
of the two grounds and therefore the conservative one — thirteen foreground colours fell below
4.5:1, the worst at **2.57:1** (`.composer-input textarea::placeholder`), with
`.arena-axis` at 2.91:1 and `.join-row input::placeholder` at 2.61:1.

All are now at or above 4.5:1, and `tests/styles.test.ts` recomputes every ratio on each run,
so a future colour tweak cannot quietly regress below AA.

---

## S3 — Polish

- **S3-A** `.chat-image` and its `img` both hard-cap at `max-height: 240px` with
  `object-fit: cover` (lines 865-866). Tall images are centre-cropped with no indication that
  content is hidden.
- **S3-B** `GameRoom.copyCode` (`app/components/GameRoom.tsx:115`) falls back to the deprecated
  `document.execCommand('copy')`. Phase 8 replaces this with the Web Share API path anyway,
  but the fallback should also surface a failure state — currently it reports "Copied" even if
  the copy silently failed.
- **S3-C** `window.confirm` for ending the session (`GameRoom.tsx:152`) is a native modal that
  breaks the visual language of the room and is not styleable.
- **S3-D** The chat opens automatically on desktop via a `requestAnimationFrame` after mount
  (`GameRoom.tsx:89-93`), which produces a visible panel slide on every room entry.
- **S3-E** `.connection-badge` hides its label under 390px (line 1096), leaving a bare colour
  dot as the only connection indicator — colour as the sole carrier of meaning.

---

## What Phase 1 deliberately does not fix

The board-dominance requirement with 30 chat messages (`P1-12`) and the one-thumb mobile
switching (`P11-06`) are listed in Phase 1 for verification, but their full design work sits
in Phase 11 alongside the accessibility pass, because both depend on the reduced-motion
state and the keyboard model landing first.
