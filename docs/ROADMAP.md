# Gridline Roadmap

Thirteen phases, ordered so that each one is verifiable when it lands and nothing is
built on an unproven foundation. Task IDs referenced here are defined in [TODO.md](./TODO.md).

## Ordering rationale

The verification muscle (Phase 3) is built **early**, immediately after the protocol
rewrite, and before any of the hard distributed-systems features. Every phase from 4
onward is then validated under chaos as it lands, rather than discovering divergence
at the end when it is expensive to fix.

```
P0 Baseline ─┬─> P1 UI/UX foundation ────────────────────────────────┐
             └─> P2 Protocol v2 ──> P3 Chaos + property tests ──┬──> P4 Presence/identity
                                                                 ├──> P5 Optimistic UI
                                                                 ├──> P6 Spectators
                                                                 └──> P7 Media/memory ──> P8 E2EE
P9 Match features ──> P10 Identity personality ──> P11 A11y/PWA ──> P12 Audit + E2E
```

---

## Phase 0 — Baseline and guardrails

**Goal.** Know exactly where we stand and make the work committable and measurable.

**Scope.** `P0-01` … `P0-07`

Establish a green baseline on all five existing gates, resolve the `git` tooling gap
(git is not currently on this machine's PATH — see [DECISIONS.md](./DECISIONS.md) D-001),
record the current bundle size and server RAM footprint as the numbers later phases are
judged against, and add the documentation set itself.

**Exit criteria.**
- `npm test`, `typecheck`, `lint`, `build`, `build:pages` all pass from a clean `npm ci`.
- `git` usable; branch strategy documented.
- Baseline metrics captured in [PROGRESS.md](./PROGRESS.md).
- Docs committed.

**Risk.** Low. This phase changes no runtime behaviour.

---

## Phase 1 — UI/UX foundation

**Goal.** Fix the defects the user reported and the systemic causes behind them. The
product should feel finished at every viewport before new features pile on.

**Scope.** `P1-01` … `P1-14`. Full defect list with root causes in [UX_AUDIT.md](./UX_AUDIT.md).

Headline items:
- **The shifting board.** `.game-board` declares `grid-template-columns: repeat(3, 1fr)`
  but no `grid-template-rows`. Auto rows size to content, so an empty row is 0px tall and
  `align-content: stretch` splits the leftover space evenly among the three auto tracks.
  Cells therefore move every time a mark lands, and only settle when all nine are filled —
  while the painted gridlines (a fixed 33.15%/66.58% gradient on the board background) never
  move. This is `P1-01`, and it is a one-line structural fix plus a regression test.
- **Unreadable type.** 69 font declarations in `app/globals.css` are between 4px and 11px;
  mobile drops to **5px** for player labels, room kicker and state chips. Phase 1 replaces
  ad-hoc pixel values with a fluid type scale whose floor is 12px for any text a user must
  read, and 11px only for decorative monospace tickers.
- **Layout stability.** Reserve space for status text, countdown and pending-move chips so
  nothing reflows mid-match.

**Exit criteria.**
- Board cells hold identical geometry from empty board through all nine marks — asserted by
  a test, not by eye.
- No user-facing text below 12px at any breakpoint; decorative labels never rely on
  `font-size: 0` to hide themselves from sighted users.
- Zero layout shift when a mark, status change, or countdown appears.
- 375×667 portrait and 667×375 landscape both usable without vertical clipping.

**Risk.** Medium — `globals.css` is 58KB of hand-tuned values; a type-scale change touches
much of it. Mitigated by doing tokens first, then migrating section by section.

---

## Phase 2 — Protocol v2: versioning, sequencing, idempotency

**Goal.** Make the wire protocol correct under reordering, duplication and clock skew,
and make incompatible clients fail loudly instead of subtly.

**Scope.** `P2-01` … `P2-10`

- `protocolVersion` in the handshake; server rejects mismatches with an actionable message.
- Server-assigned monotonic `revision` on every authoritative game update, and `sequence`
  on every chat event. Clients **discard** anything not strictly newer. Today the client
  compares `snapshot.version` (`useGameSocket.ts:156`) but chat events carry no ordinal at all.
- Every ordering decision uses server sequence IDs. No client clock participates in ordering
  or in any deadline the server enforces.
- Unified idempotency: one `requestId` ledger covering moves, chat, stickers, reactions,
  rematch votes and every future command, with a bounded TTL rather than the current
  128-entry per-player `Set`.
- Hardened Zod validation plus a fuzz suite that throws malformed frames at the server.

**Exit criteria.**
- A delayed, older snapshot arriving after a newer one provably never regresses client state.
- Replaying any command with the same `requestId` produces exactly one effect.
- 10k randomised malformed payloads: server stays up, every one rejected cleanly.
- Old client + new server, and new client + old server, both degrade with a clear message.

**Risk.** High — this is a breaking wire change against a live deployment. Server ships first;
`P2-01` exists to make the window safe.

---

## Phase 3 — Chaos harness and property tests

**Goal.** Build the instrument that proves every later phase. This is the phase that
separates a working demo from a correct system.

**Scope.** `P3-01` … `P3-09`

- **Chaos mode** behind `?chaos=1`, development builds only, never reachable in production.
  Client-side injection of 200–1200ms delay, ±400ms jitter, 5% duplicated outbound commands,
  out-of-order acknowledgements, temporary socket cuts, rapid reconnects, slow image chunks.
- **Chaos test suite** — headless, deterministic via seeded RNG, running full matches under
  800ms latency and ±400ms jitter, asserting the invariants in [INVARIANTS.md](./INVARIANTS.md).
- **Property-based game tests** — thousands of random move sequences against the pure engine
  and against `RoomManager`, proving no reachable state is invalid.
- **Playwright scaffold** — two browser contexts, real WebSocket, complete multiplayer flow.

**Exit criteria.**
- `npm run test:chaos` green across at least 200 seeded runs.
- Convergence assertion holds: after connectivity stabilises, both clients hold byte-identical
  authoritative state.
- A full match completes with `?chaos=1` enabled, manually and in CI.

**Risk.** Medium. Flaky tests here poison everything downstream, so determinism (seeded RNG,
injected clock) is a hard requirement, not a nicety.

---

## Phase 4 — Presence, identity and socket ownership

**Goal.** One human = one player, regardless of how many devices, tabs or reconnects
they use. The room survives its creator leaving.

**Scope.** `P4-01` … `P4-09`

- **Presence state machine**, server-authoritative: `online → reconnecting → offline → expired`.
  Transitions only on the server; the client renders, never decides.
- **Multi-tab ownership.** Currently `resumeSession` silently kicks the older socket with code
  4001 and a passive notice. Phase 4 makes this an explicit, documented, UI-communicated policy.
  See [DECISIONS.md](./DECISIONS.md) D-002 — recommendation is **newest connection takes control,
  older becomes explicitly read-only** rather than being closed.
- **Cross-device reclaim.** Laptop disconnects, phone resumes the same session with the same
  identity and mark; no duplicate player is ever created.
- **Host migration.** Room creation currently binds `X` to the creator; if they leave,
  `leaveRoom` destroys the entire room for both players. Phase 4 separates *host capability*
  from *player slot* so the remaining player keeps a live room.
- **Server restart behaviour.** Per the ephemeral philosophy, rooms do not survive a restart —
  but clients must show a clear "session lost" state and offer a new room, never hang.

**Exit criteria.**
- Two tabs on one session: exactly one has control; the read-only tab says so in words.
- Device handover completes with identical identity and no third player in the snapshot.
- Host leaves → remaining player still has a functioning room.
- Render restart → both clients reach a terminal, explained state within 10s.

**Risk.** High. Touches the session model that everything else depends on.

---

## Phase 5 — Optimistic UI with rollback

**Goal.** The board feels instant, and is never wrong.

**Scope.** `P5-01` … `P5-05`

Today the client is deliberately pessimistic — `README.md` states "the browser never applies a
move optimistically", and `useGameSocket.move` blocks input behind `pendingRef`. That is safe
but sluggish. Phase 5 introduces a speculative layer that renders immediately, is visually
distinct from confirmed state, and rolls back gracefully on rejection.

**Exit criteria.**
- Perceived move latency under 16ms locally.
- A server rejection rolls the cell back with an explanation; the rejected mark is never
  left on screen.
- Under chaos, no client ever displays a move the server rejected — asserted continuously
  by the Phase 3 suite.

**Risk.** Medium-high. This is precisely where optimistic UIs usually violate the
"never show a rejected move" invariant.

---

## Phase 6 — Spectators and capability tokens

**Goal.** A third party can watch without being able to influence or eavesdrop.

**Scope.** `P6-01` … `P6-07`

- Join by room code as spectator when the room has two players.
- Capability tokens — `player`, `spectator`, `host` — scoped to the room, no accounts,
  no persistence.
- Server-side authorisation on every command by capability, not by trusting a client flag.
- **Spectator privacy by default**: spectators receive game state only. Chat, images and
  reactions are withheld unless the host explicitly grants chat.
- Spectator count and identity visible to players.

**Exit criteria.**
- A spectator's move/chat command is rejected server-side even when forged by hand.
- Packet capture on a spectator socket contains no chat payload under default policy.
- Spectators leaving/joining never disturb the match.

**Risk.** Medium. Interacts with Phase 8 encryption — spectators must not hold room keys.

---

## Phase 7 — Media pipeline, memory budgets and backpressure

**Goal.** The server cannot be pushed over by images, slow readers or abandoned uploads.

**Scope.** `P7-01` … `P7-10`

- **Chunked transfer.** Replace the current single Base64 blob (up to 1.5MB inside one JSON
  frame, `protocol.ts:52-60`) with bounded chunks carrying sequence numbers, acknowledgements
  and per-chunk timeouts.
- **Memory budget.** Hard limits: 10MB active attachment RAM per room, 50MB process-wide.
  Exceeding either fails the upload gracefully with a specific rejection code.
  Current `ROOM_IMAGE_MEMORY_LIMIT` is 6MB and silently *evicts oldest* instead of refusing.
- **Backpressure.** Watch `ws.bufferedAmount`; a slow receiver must not grow server RAM without
  bound. Define and implement the drop/disconnect policy.
- **Cancellation.** User cancels mid-upload → partial buffers freed immediately on both ends.
- **Orphan cleanup.** A disconnect mid-transfer leaves nothing behind.
- **Content expiry.** Optional 5-minute TTL on messages and images even in an active room.
- **Rate-limit intelligence.** Throttle a spammer without punishing a fast, normal player —
  burst allowance plus sustained-rate ceiling, replacing the flat sliding windows in `checkRate`.

**Exit criteria.**
- Load test: 20 concurrent rooms uploading concurrently stays under the process budget.
- Killing a client mid-upload returns process RAM to baseline within the sweep interval.
- A normal player sending 6 quick reactions in 2 seconds is never rate-limited; a spammer is.

**Risk.** High. Memory bugs are the most likely cause of a Render free-tier crash.

---

## Phase 8 — End-to-end encryption and invitations

**Goal.** The server routes ciphertext it cannot read. This is currently *not* implemented
and `README.md` correctly says so.

**Scope.** `P8-01` … `P8-08`

- Room secret generated client-side, carried in the **URL fragment** so it is never sent in
  an HTTP request or WebSocket frame.
- E2EE for chat text and images using WebCrypto AES-GCM with per-message IVs.
- **Key rotation** on rematch and on session phase change; old keys destroyed.
- Chunked *encrypted* image transfer — Phase 7's transport carrying Phase 8's ciphertext.
- Web Share API invite with clipboard fallback, fragment preserved.
- **QR invite generated locally.** No external QR service — the secret must never leave
  the device.

**Exit criteria.**
- A server-side log of every received frame contains no plaintext message body.
- Rotating the key makes prior ciphertext undecryptable by the new key.
- The invite URL fragment survives share, copy and QR round-trips.

**Risk.** Very high. Key distribution is where E2EE designs usually fail. Spectator policy
(Phase 6) and this phase must be designed together.

---

## Phase 9 — Match features

**Goal.** Depth in the game itself, all server-authoritative.

**Scope.** `P9-01` … `P9-08`

- Best-of-3 / best-of-5 ephemeral series; score held authoritatively on the server.
- Optional 15s/30s turn timer, **server-authoritative** — a backgrounded tab must not grant
  extra time, and browser timer throttling must not shorten it either.
- Chess-style draw offer with accept/reject, safe against the race where both players act
  simultaneously.
- Instant rematch voting: near-simultaneous votes produce exactly one clean transition.
- In-session replay animation, destroyed with the room.

**Exit criteria.**
- Backgrounding a tab for 20s during a 15s turn loses the turn, verified in Playwright.
- Simultaneous draw offer + rematch vote never produces a double transition or a stuck room.

**Risk.** Medium.

---

## Phase 10 — Generated identity and procedural arena

**Goal.** Temporary identities with genuine personality, without persistence or accounts.

**Scope.** `P10-01` … `P10-06`

- Deterministic avatar, accent colour and symbol derived from the session seed — extending
  today's adjective-animal names in `server/rooms/identity.ts`.
- Identity must remain **textual first**: every generated visual has an equivalent name and
  description for screen readers. The avatar is an enhancement, never the only carrier of identity.
- Subtle procedural arena variation from the two players' seeds, bounded so rooms stay
  recognisably the same product.
- Incoming reactions animate from the opponent's identity position toward the arena without
  ever occluding a playable cell.

**Exit criteria.**
- Same seed → identical identity, asserted by test.
- Reaction animation path provably never overlaps the 3×3 cell region.

**Risk.** Low-medium, mostly design risk.

---

## Phase 11 — Accessibility, motion, mobile and PWA

**Goal.** Complete and pleasant without a mouse, without animation, on a small screen,
and installed.

**Scope.** `P11-01` … `P11-10`

- Full game **and** chat keyboard-operable; correct screen reader announcements for turn
  changes, moves, results, presence and incoming messages.
- **Reduced motion done properly.** The current implementation is a blanket
  `animation-duration: .01ms !important` kill switch (`globals.css:1114`). Replace it with a
  designed reduced-motion state: crossfades and state changes that read as intentional,
  not as a broken animation.
- Mobile landscape 667×375 usable.
- Desktop: the board stays visually dominant with 30 chat messages open.
- 375px mobile: switch between game and conversation one-thumb, without losing game context.
- Installable PWA that **never** pretends multiplayer works offline.

**Exit criteria.**
- Keyboard-only walkthrough: create → invite → play → chat → rematch → leave.
- Automated a11y scan clean on lobby and room.
- Installed PWA opened offline shows an honest unavailable state.

**Risk.** Medium. The PWA offline-honesty requirement conflicts with naive service-worker
templates and must be hand-written.

---

## Phase 12 — Privacy audit, log audit and full E2E

**Goal.** Prove the claims. No assertion of ephemerality survives without a test behind it.

**Scope.** `P12-01` … `P12-08`

- Repository- and runtime-wide audit for `localStorage`, `sessionStorage`, IndexedDB,
  filesystem writes, database clients, object storage, analytics and console logging.
  Known current usage: `sessionStorage` for room code/token/identity and `localStorage` for
  the mute preference (`app/lib/session.ts`) — both must be re-verified as content-free.
- **No-content log audit** as an automated test: run a full match with chat and images while
  capturing every `console.*` and server log line, assert no message body or image byte appears.
- Two-browser E2E covering the complete flow.
- Network-interruption E2E: cut and restore the socket mid-match.
- Final chaos matrix at full severity.

**Exit criteria.**
- Audit report committed with evidence, not assurances.
- Log-capture test green.
- Full E2E suite green in CI on every push.

**Risk.** Low technically; high in that it may surface work belonging to earlier phases.
Time is reserved for that.
