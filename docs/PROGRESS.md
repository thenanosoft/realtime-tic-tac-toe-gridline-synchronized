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

---

## 2026-08-31 — Phase 4 closed: presence, ownership and host migration

Branch `phase/4-presence-and-ownership`. Gates: **104 unit tests** (up from 100) and **20
end-to-end tests** (up from 16), typecheck clean, lint clean, both builds succeed.

### The structural change

A **player slot and a connection are now separate things**. A player holds
`connections: Map<peerId, Peer>` and a `controllingPeerId`; several windows may attach, exactly
one may act. Everything else in the phase follows from that.

`resumeSession` no longer closes the previous socket with code 4001. It attaches the new window,
grants it control, and tells the displaced one *why* — which is D-002 as decided. The demoted
window keeps receiving every authoritative update, because a read-only view showing a stale
board would be worse than no view at all.

Presence became a four-state machine derived from connections and the clock rather than a stored
boolean, so it cannot drift from what defines it.

### Three real bugs, each found by a test rather than by review

**1. The presence transition nobody would ever see.** `reconnecting → offline` is the passage of
time with no event to carry it. The server was right and every screen was wrong: an opponent
would sit on "Reconnecting…" indefinitely. The sweep now compares derived presence against what
was last announced and broadcasts the drift.

**2. Raising the protocol floor broke every reconnect.** `MIN_SUPPORTED_CLIENT_PROTOCOL` moved
to 2 (D-009). The end-to-end suite immediately failed with *"This version of Gridline is too old"*
— on the **second** window, not the first. `session.resume` was written straight to the socket
from the open handler rather than through the `send` helper, so it was the one command that never
got a `protocolVersion` stamped. The server read it as protocol 1 and refused it.

The bug was not the version bump; it was having two places that stamped independently. A single
`encode()` is now the only place an outbound frame is serialised.

**3. Host migration created an unplayable room.** With the room surviving its opener, a leaving X
left an O behind — and `joinRoom` handed out `'O'` unconditionally, a rule that was only ever
safe while the creator was permanently X. Two O players, no X, and the turn sitting on a mark
nobody held. `joinRoom` now takes whichever mark is free.

That one was caught by the end-to-end suite playing a move after a newcomer joined, which is
exactly the kind of thing a unit test asserting "the room survived" would have missed.

### Leaving a room changed meaning

It used to destroy the room for both players — a room died with whoever opened it. Now the slot
is freed, host migrates, the board resets to `waiting`, and the room stays joinable on the same
code. It is destroyed only when the last player leaves.

**Chat is purged on departure.** The conversation was private to the two people in it, and
whoever takes the freed slot next must not be able to read it. The confirm copy changed
accordingly: "Leave this room?" rather than "End this private session for both players?"

### INV-6 got stronger, not weaker

From "one connection per player" to "at most one *controller* per player". The old wording would
have been satisfied by simply refusing the second connection — which is precisely the behaviour
D-002 rejected. Defended by a twelve-window reconnect storm on a single token: still one player,
still exactly one window holding the slot, and a bystander's move refused with `NOT_IN_CONTROL`.

### An hour lost to a stale port, worth recording

Four end-to-end tests failed with the app stuck on "Connecting", and no server listening
afterwards. The first theory — a stale process holding 3001 — was wrong; 3001 was free. The
actual cause was the protocol-stamping bug above, and the diagnostic route that found it was
reading Playwright's captured page snapshot, which showed the rejection message verbatim.

Two strays *were* found and killed on 3399 and 3477, left by earlier background runs where
`kill` had terminated the `npx` wrapper rather than the node child. Worth knowing for next time.

---

## 2026-09-01 — Phase 5 closed: optimistic moves with rollback

Branch `phase/5-optimistic-ui`. Gates: **120 unit tests** (up from 104) and **24 end-to-end
tests** (up from 20), typecheck clean, lint clean, both builds succeed.

### The first phase since Phase 1 that a player will actually feel

Every move used to wait a full round trip to Singapore before anything appeared. Now the mark
lands on click and settles a moment later. That is the whole user-visible point of the phase —
phases 2, 3 and 4 were deliberately invisible, and it was worth saying so out loud sooner.

### INV-2 was a tautology until now, and the test knew nothing

While the client was strictly pessimistic it rendered nothing but server-supplied snapshots, so
"no client displays a move the server rejected" was true by construction. The chaos suite had
been asserting it against `client.snapshot.board` — a board the server had literally just sent.
It could not have failed.

Optimistic rendering is what makes the invariant violable, and therefore what makes it worth
having. The check moved from the snapshot to the **visible board**: the authoritative board plus
any overlay. Two things are now forbidden — a mark where the server has a different one, and a
mark the server does not have at a square this client is not waiting on. A move in flight is
fine; a move still on screen after the answer arrived is not.

### Design decisions worth recording

**The overlay never covers an occupied square.** If the authority already has something there,
it wins immediately rather than waiting for reconciliation — otherwise a losing race would paint
our mark over someone else's for a full round trip.

**Reconciliation asks what the board shows, not how far it moved.** A revision can jump by more
than one when our move and the opponent's reply arrive together, so counting revisions would
misread that as a rejection.

**Silence is not confirmation.** An unacknowledged move is withdrawn after five seconds. Without
that, a dropped frame would leave a mark on the board forever with nothing in flight to resolve
it.

**The mark stays put across a brief disconnect.** Clearing it on socket close would flicker it
off and straight back on for every reconnect, and the resume snapshot reconciles it correctly
either way. If the socket never returns, the timeout takes it off.

**An outstanding speculation blocks the next move.** This is a second, new way to break INV-1
that has nothing to do with the opponent: without it a player could place two marks in a row
locally against a board the server has not seen.

### A duplication removed rather than added to

`pendingMove`/`pendingRef` and the new speculation state were two parallel notions of "a move is
in flight", cleared in six different places between them. That is exactly the shape of the
Phase 4 stamping bug, where two independent places were responsible for one fact. The old pair
is gone; `speculation` is the single source of truth, and `settleSpeculation` the only path by
which it clears.

The "Confirming move" chip went with it. The mark's own in-flight styling says the same thing,
attached to the object in question rather than floating beside it.

### One test fixture corrected

A chaos assertion pinned `duplicatesSent > 0` for a single seed. Optimistic moves changed how
much randomness a run consumes, that seed's draw shifted, and the assertion failed while every
invariant still held — a fixture problem wearing the costume of a regression. The single-seed
test now uses a duplicate rate where zero is effectively impossible, and the 200-run sweep
asserts in aggregate that duplication and disconnection actually fired at all. A suite that
quietly stopped exercising its own chaos knobs would otherwise keep reporting a clean bill of
health.

### The end-to-end suite had to stop racing the feature

One optimistic test passed alone and failed in the full suite. Against a local server the
confirmation lands in roughly a millisecond, so the in-flight window closed before Playwright's
first poll — the test was trying to *catch* a state whose brevity is the entire point of the
phase.

Racing it harder would only have moved the flake around. Instead `e2e/support/slowMoves.ts`
holds `game.move` at the transport, which makes the window deterministic while leaving the
client, the server and the protocol completely real — only the wire is slower. The same gate,
set to hold forever, is what tests rollback. Verified by running the suite twice over.

Worth stating plainly: this is the second time a Playwright failure turned out to be the test's
timing assumption rather than the product, and both times the fix was to remove the race rather
than widen the timeout.

---

## 2026-10-08 — Phase 6 closed: spectators and capabilities

Branch `phase/6-spectators`. **129 unit tests** (up from 120), all gates green. Protocol v4;
`MIN_SUPPORTED_CLIENT_PROTOCOL` moves to 3 on the same reasoning as D-009.

A spectator is a **connection, not a slot**. It holds no token and cannot resume, because there
is no identity worth reclaiming — reconnecting simply means watching again. That is what keeps
the capability a genuinely different thing rather than a player with permissions removed, and it
is why it rests on the Phase 4 split between *holding a slot* and *being connected*.

**Privacy is enforced on the wire, not in the UI.** With chat closed, a watcher's socket never
carries the frame at all, so there is nothing for a patched client to reveal. The test reads the
spectator's socket directly and asserts the message text appears nowhere in it — a policy checked
in the client would be a suggestion.

Two refusals worth their error codes: watching a room that still has an open seat is
`ROOM_NOT_FULL` ("join it instead"), and a spectator command is `FORBIDDEN` with "you are
watching this room" rather than the previous `NOT_IN_ROOM`, which was both confusing and untrue.

A full room is no longer a dead end in the lobby — it offers to watch instead. Offered rather
than done automatically, because watching is a different thing from playing and should be chosen.

---

## 2026-10-08 — Phase 7 closed: chunked media, budgets and backpressure

Branch `phase/7-media-and-memory`. **140 unit tests** (up from 129), all gates green. Protocol v5.

The theme is that nothing unbounded may accumulate: not a partial upload, not a room's
attachments, not the process total, and not a client's send queue.

**Budget is reserved at `begin`, not at completion.** Charging only finished uploads would leave
a dozen half-finished ones sitting in memory entirely unaccounted for — the exact shape of the
leak the budget exists to prevent.

**The process total is computed, not tracked.** A running counter drifts the first time a cleanup
path forgets to decrement it, and the drift only surfaces much later as a refusal nobody can
explain. Summing a handful of rooms costs nothing and cannot be wrong.

**The idle timeout measures silence, not duration.** It restarts on every chunk, so a slow but
live upload is not punished for being slow — only an abandoned one is collected.

**Expiry is announced, not silent.** `chat.expired` carries the ids so clients revoke the blob
URLs they hold. Without that the bytes outlive the server's copy inside the browser, which is
precisely where the ephemerality claim would quietly become false.

**Rate limiting got an axis it was missing.** The flat sliding window could not tell an
enthusiastic player from a spammer: twelve messages in eight seconds throttled both. Phase 3 hit
this for real when a paced 30-message test was cut off at 24. Token buckets separate the two —
burst is what is forgiven, refill is what can be sustained forever.

**Backpressure has two thresholds for a reason.** Past 1MB buffered, only game snapshots are
forced through: they are small, and a client that misses one is left showing a stale board. Past
8MB the connection is closed, because by then it costs more memory than it is worth and the
client's own reconnect path is the cheaper recovery.

One design note on testing: the attachment ceilings are injectable. Reaching a real limit is a
better test than pushing ten megabytes of image data through a socket to prove a rule about
arithmetic.

---

## 2026-10-08 — Phase 8 closed: the server routes what it cannot read

Branch `phase/8-encryption-and-invites`. **167 unit tests** (up from 140), all gates green.
Protocol v6. README no longer says E2EE is unimplemented, because it now is.

The whole phase turns on one choice: **there is no key exchange.** Key distribution is where
E2EE designs fail, so this design does not have any. The room secret is 32 random bytes generated
in the browser and placed in the invite link fragment; both players derive generation *n* of the
key from it with HKDF, salted by room code and labelled by epoch. The server names the generation
and never has the material to compute a key from it.

**The fragment is the mechanism, not a convention.** A fragment is stripped by the browser before
the request leaves the machine. A query string is not. The invite link already existed and used
`?room=CODE`, which was fine for a code and would have been fatal for a key, so it was replaced.

**The proof is a transcript, not a reading of the code.** The socket tests keep every frame the
server received and search it for the plaintext and for the secret. An assertion that the client
called `encrypt` would pass just as happily with the plaintext sent alongside.

**Rotation had to mean something.** Each client holds exactly one generation, so deriving the next
destroys the previous one. That forced a product decision rather than a technical one: the
transcript the retired key sealed is dropped and announced, because keeping a key for convenience
cancels the phase, and keeping unreadable ciphertext gives the player a screen of blanks with no
explanation (D-010). Only in encrypted rooms — a plain room has nothing to rotate, and that
asymmetry has its own test, because it is exactly what a later refactor would flatten.

**Encryption cost the server a check, so the check moved.** It could sniff an image's magic
number while it could read the bytes; it cannot sniff ciphertext. Rather than pretend to validate,
`inspectImage` moved to `shared/` and now runs on the receiving client after decryption. The
guarantee is the same strength in a different place — and a server-side check on ciphertext would
have been theatre that passed for any blob at all.

**The QR code was the trap.** It reads as a small UI nicety, and every hosted QR generator works
by being sent the thing you want encoded — which here is the URL with the key in it. So the
encoder is in-repo: byte mode, EC level M, versions 1–10, with the specification's four penalty
rules choosing the mask. Writing the mask penalty properly is not cosmetic; the symbol a camera
fails to read is the one that looks to the user like a broken invitation. It is tested by decoding
the symbol back with an independent reader at every supported version, which caught two real bugs
in an afternoon: the reader over-reserving the middle of row 8 and column 8, where data actually
lives, and the version-10 character count field being read as byte-aligned when it is bit-aligned.

One interaction worth recording: Phase 6 lets a host open chat to spectators, and the right
response to that under encryption was to change nothing. A spectator joins by code, holds no key,
and therefore cannot read an encrypted room's chat whether the host opened it or not (D-011). The
guarantee does not depend on the host understanding how two features interact.

---

## 2026-10-08 — Phase 9 closed: depth in the match, authority unchanged

Branch `phase/9-match-features`. **184 unit tests** (up from 167) plus two new Playwright specs.
Protocol v7.

Four features, one rule: the server decides. The series score, whether a series is over, when a
turn expires, whether a draw stands — all of it is snapshot state the client renders.

**The score is keyed by player, not by mark.** Marks swap on every rematch, so a score kept
against a mark changes hands with it. The test plays three rounds specifically to catch this: the
same person wins round one as X and round two as O, and a mark-keyed score would credit the second
win to the loser.

**A turn that runs out passes rather than forfeits** (D-012). The usual cause of an expired turn
is a phone locking its screen, and ending someone's game for that is a worse product than ending
their move. The competitive objection answers itself — a player who keeps running out loses anyway
by never placing a mark. The expiry is announced, because the board does not change and the turn
would otherwise move for no visible reason.

**Playwright earns its keep here.** The unit suite proves the server expires a turn against its
own clock, which is the invariant. What it cannot show is a real tab that stops receiving timers:
Chromium throttles a backgrounded one, and a client-side countdown would simply stop. So the spec
opens a second page to genuinely background the first, waits past the limit, and finds the turn
gone and the board untouched.

**Simultaneous draw offers are an agreement, not a race** (D-013). Both players just said they
want a draw; any answer other than "drawn" throws that away and makes the result depend on arrival
order neither player can see. Playing on withdraws an offer, because otherwise a player could
accept a draw in a position that no longer exists — and a response carries the round it answers,
so an acceptance in flight when the round ended cannot draw the next one.

**Replay is derived, not stored.** The playback condition includes the phase, so a replay cannot
outlive its round: if the room moves on, the replay stops being true and the live board returns
with nothing to unwind. Holding the step in state and clearing it from an effect would have meant
racing the snapshot that invalidated it.

Two bugs worth recording, both in the tests rather than the server, and both the same shape: a
`waitFor` scanning the whole message history matched states the room had already left. Round two
refills the same cells as round one, so "wait until cell 3 is filled" was satisfied instantly by a
round-one snapshot and the test raced ahead of the move it was waiting for. The fix is a cursor —
wait only on frames that arrived after the send. This is the third time this shape has appeared
(the e2e suite hit it in Phase 5), which is a sign the helper should have carried a cursor from
the start.

---

## 2026-10-08 — Phase 10 closed: identity with no protocol and no storage

Branch `phase/10-identity-and-arena`. **199 unit tests** (up from 184). **No protocol change** —
which is the most interesting thing about the phase.

Every player already has a server-issued temporary name. Making that name the seed means the
accent, the symbol and the sigil are a pure function of something both clients already hold, so
the whole feature needs nothing on the wire and has no skew window to manage between the two
deploys. It also means nothing is stored: the identity is recomputed from the name every time, so
there is no identity record to persist, leak or expire. The alternative was the player id, which
has more entropy and is invisible to the player; the name wins because the identity then visibly
belongs to the thing the player is shown.

**The palette is fixed rather than generated, on purpose.** Random hues were the obvious
implementation. But the colour also labels a player, so a hue that lands unreadable is an identity
that lands unreadable — and the test now computes contrast for all twelve accents against the
application ground. Generated colour would have made that assertion impossible to write.

**Textual parity is a data property, not a UI one.** Every accent has a name and every symbol a
label, and the description built from both is what the sigil announces. That is checked for all
480 names the server can issue, so the visual can never become the only carrier of identity.

**The reaction path is arithmetic because the requirement is a proof.** "Never occludes a playable
cell" cannot be established by looking at a keyframe. So the path is a function in board widths,
and the test walks a thousand points along it for both sides and asserts the whole glyph box
clears the 3×3 region with margin. Progress is clamped, which matters: a timer overrunning by a
frame would otherwise fling the glyph across the board.

**One real bug, found by testing the whole input space.** `^` in JavaScript yields a *signed*
32-bit integer, so the hash mixer returned a negative remainder for about half of all seeds — a
negative array index and an `undefined` accent. A spot check on three names would have passed half
the time. Asserting over all 480 names failed immediately and unambiguously.

---

## 2026-10-08 — Phase 11 closed: usable without a mouse, without motion, and offline

Branch `phase/11-accessibility-motion-pwa`. **213 unit tests** (up from 199) and five new
Playwright specs. No protocol change.

**The automated scan earned its place immediately.** axe found something no review had: the board
declared `role="grid"` and put `role="gridcell"` straight inside it, with no rows. Nine cells
promising a structure that was not there. The fix is row wrappers at `display: contents` — the CSS
grid is untouched, and the accessibility tree gets what the role promised.

**Announcements are derived, not stored.** Both live regions are a pure function of the snapshot,
computed during render. A live region announces when its text changes, so no state and no effects
are needed — and it cannot drift from the screen, double-announce after a re-render, or announce a
state the room has already left. The urgency split is the real design work: polite for the turn,
the move, presence and incoming messages; assertive only for the result, the series and losing the
network. Every assertive announcement cancels the one before it, so a game that shouted everything
would be unusable.

**Reduced motion is now a state rather than a switch** (S1-C, open since Phase 1). The blanket
`.01ms` override did stop the movement, and it also made everything *snap* — a countdown that
teleports between numbers reads as a broken interface. What replaces it keeps what carries meaning
(something changed, and which thing) and drops what carries only style (travel and scale).

**The offline work went wrong in an instructive way.** The first implementation gated connection
attempts on `navigator.onLine`, which produced exactly the failure the task exists to prevent: a
device whose link returned sat in an offline state forever, because the only thing that would have
noticed was the attempt it was refusing to make. `onLine` reports whether the machine has a link,
not whether anything is reachable — so it is now a diagnosis of *why* a socket failed, never a gate
on trying. A second finding came out of the same test: a dropped link does not always close a
socket, so recovery re-derives the connection state instead of assuming it needs a new one.

**Everything in the PWA is hand-written, including the icons.** `scripts/generate-icons.mjs` draws
them: a PNG is a signature, three chunks and a CRC. The alternative was an image-processing
dependency this project does not otherwise need, after two phases spent establishing that sending
things to a service you do not need is a cost. The service worker serves navigations network-first,
which the usual cache-first template gets backwards twice over — it pins installed users to a stale
build, and it makes an offline app look like a working one.

**One product bug fell out of the test work.** Encryption is on by default, and a guest who joins
by typing the room code holds no key — so their messages were refused on send, silently, leaving
the text sitting in the box. The composer now refuses up front and says why, the lobby says what a
code does and does not carry, and the E2E harness joins by link, the way an invitee actually does.

---

## 2026-10-09 — Phase 12 closed: the claims now have tests behind them

Branch `phase/12-privacy-audit`. **231 unit tests** (up from 213, plus the matrix skipped by
default) and 28 Playwright specs. No protocol change. This closes the programme.

The phase's whole premise is that an assertion about privacy is worth nothing without something
that fails when it stops being true. So the audit is a test file, not a document — one rule per
category of persistence, each with an allowlist — and `docs/PRIVACY_AUDIT.md` is the readable
version of what that file enforces, with every claim naming a file or a test.

**The log audit is a capture, not a reading.** It plays a full match — sealed text, a sticker, a
reaction, a sealed image over the chunked transport, five moves — with every console channel and
the raw stdout/stderr writes intercepted, then searches the output. Two details matter. It
provokes the error paths too, because an error handler that serialises the frame it choked on is
exactly the leak a code review misses. And it asserts the output is **empty**: "it did not log the
secret" is a weaker claim than "it did not log", and the second is the one this product makes.

**Two of my own rules caught me.** The filesystem rule flagged `scripts/verify-production.mjs`,
which reads source to find the protocol version — a legitimate build-time read that now sits in
the allowlist with its reason. And the no-room-content rule flagged `error.message` in the server
entry point, which is an Error's message rather than a chat message; the rule now looks for room
vocabulary instead of the word "message". Both are exactly what an allowlist is for: the rule
forced the exception to be named.

**`context.setOffline` is the wrong tool for a network-interruption test**, and finding that out
was worth the detour. It drops the link without closing an open socket, so the server never learns
the player has gone and the opponent sees nothing at all — the test would have passed while
proving the opposite of its name. `e2e/support/cutSocket.ts` closes the socket from inside the
page and refuses new connections until restored, which is an interruption the server actually
sees: presence changes, the room pauses, and the board is held exactly as it was.

**Testing Phase 12 found two Phase 9-11 regressions**, which is the risk the roadmap reserved time
for. The board had started moving as marks landed — not the old row-sizing bug, but the match
panel growing and shrinking above it as its contents changed. The panel is now one fixed-height
row with the format controls in a popover laid over the arena rather than above it. And the
landscape layout had overflowed by 82px as the panel and the identity block were added, so the
chrome around the board gives up more height and the board is sized from what is left.

One test was also measuring the wrong thing: cell geometry in viewport coordinates reported a
one-off scroll as a moving board, once the room grew past the window. It measures against the
board frame now, which is what P1-02 was always about.

---

## 2026-10-09 — Phase 13, part one: an opponent that is not a person

Branch `phase/13-solo-and-audience`. **251 unit tests** (up from 236) and four new Playwright
specs. No protocol change — deliberately.

A solo game has no second person in it, so it opens no room, holds no socket and puts no board on
a server. That decision kept the whole feature out of the room machinery, which otherwise would
have had to grow a notion of a player who is not a person: presence for something that is never
offline, a reconnect deadline for something that never disconnects, a chat partner that never
types. It also means solo play works with the network down, which is exactly when someone is most
likely to want it — so the offer stays visible while the connection is gone.

**Four levels that think in different terms**, not one engine behind a difficulty dial. A strong
engine with a "mistake chance" plays perfectly and then throws the game away at random, which
reads as a cheat rather than as a weaker player. Casual does not look ahead at all. Keen looks
exactly one move ahead — it will take a win and block a loss and miss a fork, which is a specific
weakness rather than a general one. Sharp searches and slips once in five, and the slip is the
best of what is left after discarding the strongest move, so a player who loses feels outplayed
rather than pitied. Flawless searches.

**"Unbeatable" is the kind of claim that deserves a proof rather than a demonstration.** The test
plays every game a human could play against Flawless — the whole tree of human choices against a
deterministic reply — and asserts no leaf is a human win, from both openings. Two smaller things
fell out of writing it: minimax has to score by depth or it will happily take a win in five moves
over the same win in one, which from the other side of the board looks like being toyed with; and
in a position where every move is equally good there is nothing for Sharp to slip *into*, so the
first version of that test was asserting a slip in a position that did not admit one.

The screen renders the real `GameBoard` by building a snapshot of the shape the server sends.
That assembly is worth it: the board carries the keyboard handling, the winning-line geometry and
the accessible labels, and a second copy of it would drift from the first within a release.

Nothing is stored. The level and the record live in memory, because persisting them would mean a
new browser-storage key and `tests/privacy.test.ts` would fail — correctly. The ladder resetting
when you leave is the honest version of a product that says it leaves nothing behind.

---

## 2026-10-09 — Phase 13, part two: one link, and an audience that can take the chair

Protocol v8. **264 unit tests** (up from 252) and seven new browser specs.

The room used to be a pair with onlookers: the second arrival became a player, everyone after
needed a different link, and watchers could see the board and nothing else. It is now a place with
an audience that can join it.

**One link, and roles decided inside the room.** Opening an invitation at a full room makes you a
watcher rather than sending you back to the lobby to press "watch instead" — by opening the link
you already said what you wanted, and which chair you get is the room's business. Typing a code by
hand still offers the choice, because there the person may genuinely have meant to play.

**The key goes with the link, which withdraws a guarantee** (D-015). D-011 said a watcher provably
could not read an encrypted room's chat. One link for everyone makes that false, and it cannot be
both ways: the key lives in the link. What is unchanged — and is the part the encryption is for —
is that the server cannot read any of it. The circle grew from "the two people playing" to
"everyone holding the link", which is what the share panel has said in those words since Phase 8.
Spectator chat therefore defaults to **on**: withholding a conversation from people who already
hold the key to it protects nothing.

**Seating is between rounds, and the control says why when it is not available.** Swapping
mid-round would hand someone a position they did not choose to enter; queueing the change until
the round ended would spring a decision made minutes earlier on a room that had stopped expecting
it. Seating starts a new series, because carrying the score forward would credit the newcomer with
rounds somebody else lost.

**Names travel with messages now.** They used to be looked up in the player list when a message
was rendered, which stopped working the moment watchers could talk — and was already wrong for
anyone seated out since they spoke. The server resolves the name when the message is stored, so
what you said keeps your name on it whatever happens to you afterwards.

Two things worth recording from the work. The chat paths all took a `Player`, so letting watchers
speak meant either branching at every call site — which is how one of the two roles quietly ends
up without a rate limit — or giving the paths the thing both roles are. They take a participant
now, and the ledger and rate-bucket helpers were widened to match.

And the stale-snapshot trap caught me for the fourth time: a test waited for "nobody watching",
matched a snapshot from before the watcher ever arrived, and sent its command while the room was
still full. The server was right; the test was asserting against history. Every socket helper in
the suite now takes a cursor, and this one did too — I just used it in the wrong place.
