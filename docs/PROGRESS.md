# Progress log

Newest first. One entry per phase closed, plus notable mid-phase events. Written when work
actually lands, never in advance.

---

## 2026-08-29 — Programme opened

**State inherited.** Gridline is deployed and working end to end:

- Frontend on GitHub Pages, static export, base path applied.
- Backend on Render (free tier, Singapore), `render.yaml` blueprint, `/health` + `/ws`.
- `NEXT_PUBLIC_WS_URL` configured as an Actions variable; Pages workflow run #5 green.
- Duplicate Pages workflow removed in `3f7d905`.
- Verified in production: two players joined, moves synchronised, no console warnings or
  errors. The earlier "production realtime endpoint not configured" warning is resolved.

**Codebase at start.**

| Area | Files | Notes |
| --- | --- | --- |
| Shared | `shared/protocol.ts`, `shared/game.ts` | Zod discriminated client union, pure game engine |
| Server | `server/rooms/RoomManager.ts` (29.7KB), `createGameServer.ts`, `identity.ts` | All room state in process RAM |
| Client | `app/hooks/useGameSocket.ts` (17.7KB), 8 components | Pessimistic moves, Blob URL lifecycle management |
| Styles | `app/globals.css` (58.2KB) | Hand-tuned, no type scale |
| Tests | `tests/multiplayer.test.ts` (22.4KB), `game.test.ts`, `identity.test.ts` | Unit + integration, no E2E, no chaos |

**Work done this session.**

- `P0-04` Created the `docs/` engineering record: README, ROADMAP (13 phases),
  TODO (~110 tasks with stable IDs), UX_AUDIT, INVARIANTS (12 properties), DECISIONS, this log.
- Audited the reported UI defects and found the root causes rather than the symptoms:
  - The shifting board is a missing `grid-template-rows` on `.game-board`, combined with
    gridlines painted as a fixed background gradient. Full analysis in `UX_AUDIT.md` S1-A.
  - Small type is systemic — 69 declarations under 12px, mobile bottoming out at 5px. There is
    no type scale in the codebase, so there was never a floor to violate.
  - Found seven further defects not originally reported, including clipped diagonal winning
    lines, no landscape layout at any breakpoint, sub-44px tap targets, a reduced-motion
    blanket kill switch, and a 9px chat input that triggers iOS zoom-on-focus.

**Toolchain resolved** (`P0-01`). Git 2.55.0.3 installed via winget; the Node/Flutter/Android
toolchain under `D:\Android` added to the persistent user PATH; `safe.directory` exception added
because the working tree is owned by a SID from a previous Windows installation. Full record in
`DECISIONS.md` D-001.

**Baseline gates** (`P0-02`) — all five green, no pre-existing failures:

| Gate | Result |
| --- | --- |
| `npm test` | 24 tests, 3 files, all pass — 5.80s |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` (vinext) | pass — 1 static route |
| `npm run build:pages` (next export) | pass — `/` and `/_not-found`, both static |

**Baseline metrics** (`P0-03`) — the numbers later phases are measured against:

| Metric | Value |
| --- | --- |
| `out/` total | 2,709 KB across 39 files |
| — JavaScript | 1,386 KB across 11 chunks |
| — CSS | 53 KB, 1 file |
| — HTML | 42 KB, 4 files |
| Largest chunk | 521 KB (`425eqet9207t4.js`) |
| Largest asset overall | 619 KB (`og.png`) |
| Sticker sheet | 431 KB (`gridline-stickers.webp`) |
| Server idle RSS | 37.1 MB working set / 49.4 MB private bytes |
| `/health` at idle | `{"status":"ok","rooms":0}` |

Two observations worth carrying into later phases: the 521 KB primary chunk and the 431 KB
sticker sheet together dominate first load, and neither has been examined for necessity yet.
Server RSS *with an active room holding an image* is still uncaptured — it belongs with the
Phase 7 memory-budget work, where it is the number that actually matters.

**Open decisions awaiting the user.**

- D-002 — multi-tab ownership policy. Recommendation recorded; needed before Phase 4.

---

## 2026-08-29 — Phase 1 closed: UI/UX foundation

Branch `phase/1-ui-foundation`. Gates: **46 tests pass** (up from 24), typecheck clean, lint
clean, both builds succeed. The board fix was verified present in the *compiled* CSS, not just
the source.

### The reported bug, and what actually caused it

`.game-board` declared `grid-template-columns: repeat(3, 1fr)` and **no `grid-template-rows`**.
The three rows were implicit `auto` tracks. An empty cell has zero content height, because
`.ghost-symbol` is absolutely positioned — so with a definite board height from
`aspect-ratio: 1`, `align-content: stretch` split the surplus *equally* across the three auto
tracks rather than proportionally. A row holding a mark ended up taller than an empty one, and
the rows only equalised once all nine cells were filled.

Compounding it, the gridlines were painted as fixed percentage bands on the board *background*
(`33.15%`, `66.58%`), so they never moved while the cells did. Lines and cell boundaries drifted
apart mid-match.

Both halves are fixed: both axes are now explicit, and the lines are drawn by the cells
themselves via `:nth-child` borders, so they cannot disagree again. `.teaser-board` on the lobby
had the identical defect and got the identical fix.

### Typography

There was no type scale — every size was an independent hand-tuned pixel value, which is why
there was never a floor to violate. 69 declarations sat between 4px and 11px, bottoming out at
**5px** on mobile for player labels, room kicker, slot labels and state chips.

A token scale now exists (`--text-micro` 11px for decorative monospace only, `--text-2xs` 12px
through `--text-lg` 19px, plus `--tap: 44px`). All 69 declarations were migrated, and a test
fails the build on any literal font size below 12px. The chat composer moved to 16px
specifically because iOS Safari zooms the viewport on focus for anything smaller, which threw
the player out of the arena mid-match.

### Contrast, measured rather than eyeballed

The original audit blamed `--dim: #5c5e5d`. That token turns out to be declared and **never
used** — so did `--muted`. Computing every ratio instead found the real failures: thirteen
foreground colours below 4.5:1 against the raised panel tone, worst at **2.57:1**. All now pass,
and the test recomputes every ratio on each run rather than trusting a one-time sweep.

### Also fixed

- `font-size: 0` label-hiding replaced with a `.btn-label` collapse utility, so labels stay in
  the accessibility tree instead of depending on an `aria-label` being present on every control.
- Mobile tap targets raised from 25–34px to 44px, including the destructive leave-room button.
- `.game-status` given a fixed height and its detail copy a reserved two-line box, so wrapping
  text and the appearing rematch button can no longer nudge the board.
- A landscape breakpoint added. There was no `orientation` query anywhere in the file; at
  667×375 the board was sized `calc(100svh - 470px)`, which computes **negative**.
- The connection badge keeps its word at ≤390px. It previously collapsed to a coloured dot,
  leaving colour as the only carrier of meaning for sighted users.

### One finding withdrawn

The audit claimed `overflow: hidden` clipped the diagonal winning lines. Working the geometry
through, the far end lands at `0.9214S` on a board of side `S` — comfortably inside, glow
included. Not a defect; no change made. The entry is kept in `UX_AUDIT.md` rather than deleted,
since a withdrawn finding is part of the record.

### Carried into Phase 3

`P1-02`, `P1-10` and `P1-14` all need a real layout engine — pixel-measured cell boxes, portrait
visual confirmation, and visual snapshots. They are tracked as `P3-10` against the Playwright
scaffold. The structural regression tests that *can* run without a browser are in place now.

`S1-C` (reduced motion is a blanket `.01ms` kill switch) remains open by design: the roadmap
puts the designed reduced-motion state in Phase 11 alongside the accessibility pass, and doing
it properly is design work, not a CSS tweak.
