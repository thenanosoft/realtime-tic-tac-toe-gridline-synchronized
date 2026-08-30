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

---

## 2026-08-29 — Phase 2 closed: protocol v2

Branch `phase/2-protocol-v2`. Gates: **72 tests pass** (up from 46), typecheck clean, lint
clean, both builds succeed.

### Versioning (P2-01)

`PROTOCOL_VERSION = 2`. `server.hello` now advertises both `protocolVersion` and
`minClientProtocol`, and every client command carries an optional `protocolVersion`.

The optionality is the important part. Pages and Render deploy independently, so a version
skew window always exists — making the field required would have cut every in-flight client
off the moment the server shipped. Absent is read as v1 and still served, which is what D-004
asks for. A client claiming a version the server cannot speak gets `PROTOCOL_MISMATCH` with a
message that says what to do, and the socket stays usable afterwards.

### Ordering (P2-02, P2-03, P2-04)

`RoomSnapshot.version` is now `revision`. The rename was not cosmetic: `version` and
`protocolVersion` in the same file are genuinely confusing, and this was the release to fix it.

Chat previously had **no ordinal at all**. It now has one monotonic `sequence` per room across
every chat event.

The subtle part was deciding what "discard stale events" actually means. Applying it uniformly
would have been wrong: a delayed `chat.message` arriving after a later `chat.typing` would be
dropped, silently losing a message. So the rule is split by what the event does —

- events that **overwrite** state (typing, reaction sets) are discarded when stale, because
  applying one resurrects a state the sender already cleared;
- events that **append** (messages) are never dropped for lateness, only inserted at the
  position their sequence names.

Same guarantee, no data loss.

### A modelling error the tests caught

The first cut put `serverTime` and the countdown duration inside `RoomSnapshot`. An existing
test comparing two clients' snapshots immediately failed on a one-millisecond difference — and
it was right to. Durations decay between emissions, so a snapshot carrying them can never be
byte-identical across clients, which breaks **INV-3** exactly when Phase 3 will need it most.

Fixed by splitting emission-scoped timing into a separate `timing` envelope on the message.
`RoomSnapshot` is now a pure function of the room at a revision. `updatedAt` went with it —
it was mutated by `touch()` without a revision bump, so it had been quietly breaking purity all
along, and nothing on the client read it.

There is now a test asserting two clients at the same revision hold deep-equal snapshots.

### Clocks (P2-05)

Every absolute epoch is out of the authoritative snapshot. Deadlines travel as durations, and
the countdown renders from `performance.now()` — monotonic, unaffected by system clock changes
or NTP steps. No client clock participates in ordering or in any deadline.

### Idempotency (P2-06, P2-07)

The old scheme was a 128-entry `Set` per player plus an O(n) linear scan of chat history for
duplicate detection. Replaced with one TTL-bounded ledger (120s, 512-entry backstop) that
records *what a replay should return*, so the reply is rebuilt from current state rather than
re-executed.

Two behaviour changes fell out of it. The ledger is consulted **before** the rate limiter — a
client retrying a command it never saw acknowledged should not be throttled for retrying. And
the ledger is no longer cleared on rematch: request ids are UUIDs and are never reused, so
clearing only widened the window for a delayed duplicate to execute twice.

### Hardening (P2-08, P2-09, P2-10)

10,000 seeded malformed frames — bad JSON, wrong types, unknown commands, deep nesting,
`__proto__` as a message type, unbalanced brackets — delivered in bursts across fresh sockets
so the socket rate limiter does not mask the run. The server survives and still serves the next
valid command.

The compatibility decision was extracted into `app/lib/protocolCompatibility.ts` so the whole
skew matrix is unit-testable without a browser: agreement, legacy server, malformed version,
client behind, client ahead, and unsupported client.

### One test-harness bug fixed on the way

`Probe.connect` attached its message listener after awaiting `open`, which races the
`server.hello` frame the server sends immediately on connection. It only surfaced once a test
actually waited for that first frame. The listener is now attached at construction.

### Deployment note

This is a breaking wire change. Per D-004 the **server ships first** — it accepts both v1 and
v2 clients — and the Pages frontend follows. Deploying in the other order would leave v2
clients talking to a v1 server, which degrades with a notice but cannot play.
