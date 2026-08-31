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

---

## 2026-08-29 — Phase 3 closed: chaos harness and property tests

Branch `phase/3-chaos-and-properties`. Gates: **85 unit tests** (up from 72) plus **16
Playwright end-to-end tests**, typecheck clean, lint clean, both builds succeed.

### The phase found a real bug, which is the point of the phase

The chaos suite failed on its first run — and only on seeds where a disconnect occurred. Ten
of fifty such runs reported the same violation: *"X and O could both move"*.

It was not a simulation artifact. `useGameSocket` set `connection = 'connected'` the instant
the socket opened, **before** `session.resume` was answered. `GameRoom.canMove` gated on that
flag, so during the resume round-trip a reconnecting player was shown the board they had held
before the drop — stale, but fully interactive — while their opponent, who never disconnected,
also had a live board. Both could click. One of them was going to be told the room had changed.

Fixed with a `resyncing` flag: the board stays inert from socket open until the server confirms
the session. `INV-1` has been reworded to match what is actually enforceable — see below.

### INV-1 was too loose to be testable

The original wording was "at no point may both players believe it is their turn". That cannot
hold: mid-propagation one client holds revision 5 and the other revision 6, and both *read* as
"your turn" for one network delay. Nothing is wrong at that moment — the client on the older
revision has a move in flight and cannot act.

What must never happen is that both can **act**. That is the property the UI gates on, the one
that produces a visible snap-back when violated, and the one the suite now measures.

### What was built

- **`shared/chaos.ts`** — seeded mulberry32 RNG and a pure chaos policy: per-frame delay,
  jitter, duplication, loss. Delays are drawn independently per frame, so reordering emerges
  the way a variable link produces it rather than being injected as a separate step.
- **`app/lib/ordering.ts`** — the client's ordering rules extracted as pure functions, so the
  simulation drives the *same* logic the browser runs. A hand-written approximation would have
  made a green chaos run evidence about a parallel universe.
- **`app/lib/chaos.ts`** — the `?chaos=1` browser transport, development-only.
- **`tests/support/simulation.ts`** — the real `RoomManager` behind the real command dispatcher
  (`executeClientMessage`, exported from `createGameServer` for exactly this reason), driven by
  vitest fake timers so 800ms of latency costs microseconds and replays exactly from a seed.

### Stripping the chaos transport took two attempts

The first version guarded the dynamic import with a `chaosRequested()` helper. `NODE_ENV`
inlines to `'production'`, so the helper constant-folds to `return false` — but the minifier
cannot prove that *the call* is always false, and the chunk shipped anyway. Verified by
grepping the built output, which is why the check exists.

Moving the condition inline at the call site makes it `if (false && …)`, and the whole branch
including the dynamic import disappears. The test greps `out/` for a marker string and, in CI,
**fails rather than skips** when `out/` is absent — otherwise the one assertion that proves the
stripping would quietly become a no-op.

### Numbers

| Suite | Coverage |
| --- | --- |
| Chaos matches | 200 seeded runs at 800ms ±400ms, 5% duplication, disconnects on every fourth seed. All 200 finish; all 200 converge byte-identically. |
| Engine properties | 5,000 seeded move sequences over eight structural properties; 1,000 more asserting every illegal move is refused from every reachable state. |
| RoomManager properties | 500 hostile command sequences (stale revisions, duplicate request ids, out-of-turn moves, mistimed votes); 200 runs asserting two peers never diverge. |
| End-to-end | 16 tests, two browser contexts, real WebSocket. |

### Phase 1's deferred work is now closed

`P1-02`, `P1-10` and `P1-14` all needed a real layout engine. In `e2e/layout.spec.ts`:

- Every cell is square and equal on an empty board, and **no cell moves by more than 1px**
  across a full nine-mark draw — the direct proof that the reported bug is gone.
- Adjacent cell edges meet within 1.5px, so the gridlines provably sit on the boundaries.
- 375×667, 667×375, 768×1024 and 1440×900 all measured for overflow, board geometry and tap
  targets.
- Nothing renders below 11px; prose and identity text at 12px or above; the composer at 16px.
- The board stays dominant with **30 real chat messages** in the panel, and does not move by
  more than 1px as they arrive.

**A substitution worth recording:** `P1-14` asked for visual snapshots. Screenshot baselines
differ across operating systems and font stacks, so a committed baseline would have been a CI
flake generator rather than a safety net. Measured assertions catch the defects this phase is
about — drifting cells, collapsed boards, unreadable text — without that cost.

### Two things the landscape work turned up

The 667×375 layout added in Phase 1 was **still overflowing vertically by 43px** — the browser
found what the stylesheet reading could not. `min-height: calc(100svh - 48px)` on the room plus
the topbar plus page padding exceeds the viewport by construction. Now the arena sizes itself
and the board is derived from the remaining height budget.

Separately, driving 30 chat messages hit the server's rate limit at 24. The limit is a flat
12-per-8-seconds sliding window that cannot tell an enthusiastic player from a spammer — which
is exactly what `P7-09` exists to fix. Recorded there as evidence rather than worked around.

### CI

`e2e.yml` runs the chaos, property and Playwright suites on push and pull request, deliberately
**separate** from the Pages deploy workflow. A five-minute browser run on a free runner in
front of every deployment would make shipping slow and hostage to browser flake. `pages.yml`
keeps its fast unit, type and lint gates, and gains one post-build step: the chaos-transport
bundle check, which has to run after `build:pages` because it reads `out/`.

---

## 2026-08-31 — Phases 0–3 merged to `main` and deployed

`main` fast-forwarded from `b02f5ee` to `c02aa53` and pushed. Six commits, 34 files,
+3,837/−376.

### The backend deployed cleanly and is verified in production

Render picked up the push and **protocol v2 was live 21 seconds later**, confirmed by probing
`server.hello` directly — `/health` reports no version, so it cannot answer this question.

A real two-player match was then played against the deployed backend
(`npm run verify:production`, now a committed script). Fifteen checks, all passing: protocol
advertisement, `revision` replacing `version`, the timing envelope sitting outside the snapshot,
no absolute deadlines in authoritative state, chat sequences, distinct generated identities,
a completed win, both clients converged, a replayed move changing nothing, and a
`PROTOCOL_MISMATCH` rejection that leaves the socket usable.

### The frontend deploy failed, and it was my mistake

The Pages workflow failed at `npm test`. The cause was a change I made minutes before pushing:
the bundle-stripping check had been set to **throw rather than skip whenever `CI` was set**, so
that it could not silently become a no-op. But `npm test` runs *before* `build:pages` in that
workflow, so `out/` legitimately does not exist yet — and the check failed the deploy.

Reproduced locally with `CI=true` and no `out/`, which showed the failure exactly.

Fixed by gating strictness on a dedicated `REQUIRE_BUILT_BUNDLE`, set only by the post-build
step. All three modes are now verified:

| Condition | Behaviour |
| --- | --- |
| `CI`, no `out/` (the pre-build test step) | skips |
| `REQUIRE_BUILT_BUNDLE`, no `out/` | fails loudly |
| `REQUIRE_BUILT_BUNDLE`, real `out/` | passes |

The original instinct was right — a check that quietly skips is worthless — but the trigger was
wrong. `CI` means "running in automation", not "the build has happened".

### The verification script had a race of its own

Its first production run passed and the second failed. Not the product: the helper scanned the
whole message history, so *"is it my turn?"* matched a snapshot from before the client's own
last move, and the winner was read from a client still a revision behind.

Fixed with a `waitUntil` that only ever examines current state, plus waiting on **both** clients
after each move rather than just the observer. Three consecutive clean runs since.

Also removed a `.ts` import from that script: it relied on Node's type stripping, on by default
only from 22.18, while `package.json` allows 22.13. The constant is now read from the shared
source directly, keeping one source of truth without quietly raising the version floor.

### On the deployment window

D-008 records what was actually observed: the two deploys cannot be sequenced, the v1 server was
still answering while the Pages build ran, and the honest-degradation path from `P2-01` is what
covers the gap. In this instance the ordering worked out in our favour anyway — the backend was
live in 21 seconds and the frontend deploy failed, so no v2 client ever met a v1 server.
