# Gridline TODO

The single source of truth for what is done. IDs are stable and permanent — reference them
in commits (`P1-01: give the board explicit grid rows`).

Status: `[ ]` not started · `[~]` in progress · `[x]` done and tested · `[!]` blocked

---

## Phase 0 — Baseline and guardrails

- [x] **P0-01** Resolve the toolchain gap. Git 2.55.0.3 installed; `D:\Android` tool directories
      added to the persistent user PATH; `safe.directory` exception added for the working tree.
      See D-001 for the full record.
- [x] **P0-02** All five gates confirmed green: 24 tests pass, typecheck clean, lint clean,
      `build` and `build:pages` both succeed. No pre-existing failures.
- [x] **P0-03** Baseline metrics recorded in `PROGRESS.md`.
- [x] **P0-04** Create the `docs/` engineering record (this set).
- [x] **P0-05** Point `CLAUDE.md` at `docs/` so future sessions load the plan.
- [x] **P0-06** Document the branch and release strategy — server ships before client for any
      protocol change. In `docs/README.md`.
- [ ] **P0-07** Add `npm run test:e2e` and `npm run test:chaos` scripts. Deferred to Phase 3,
      where the suites they invoke are actually built — a placeholder script that fails would
      only make CI red for no signal.

## Phase 1 — UI/UX foundation

- [ ] **P1-01** **Board geometry.** Add `grid-template-rows: repeat(3, 1fr)` to `.game-board` and
      make cells square-stable. Root cause of the "gridline moves until all boxes are filled" bug.
- [ ] **P1-02** Regression test: cell bounding boxes are identical for an empty board, a
      partially-filled board and a full board.
- [ ] **P1-03** Move the painted gridlines off the background gradient onto real, cell-derived
      borders so lines and cells cannot drift apart again.
- [ ] **P1-04** Define a fluid type scale as CSS custom properties (`--text-2xs` … `--text-3xl`),
      floor 12px for readable text, 11px for decorative monospace only.
- [ ] **P1-05** Migrate all 69 sub-12px font declarations in `app/globals.css` to the scale.
- [ ] **P1-06** Remove `font-size: 0` label-hiding on mobile (`.sound-toggle`, `.chat-toggle`);
      use proper icon buttons with accessible names.
- [ ] **P1-07** Raise mobile tap targets to ≥44×44px (currently 31–34px for copy/chat/leave).
- [ ] **P1-08** Reserve layout space for `.game-status`, `.move-pending` and the countdown so no
      reflow occurs mid-match.
- [ ] **P1-09** Fix `.winning-line` diagonals being clipped by `.game-board { overflow: hidden }`.
- [ ] **P1-10** Verify 375×667 portrait: no clipping, no horizontal scroll, board dominant.
- [ ] **P1-11** Add a 667×375 landscape layout — no such breakpoint exists today, and
      `min-height: calc(100svh - 64px)` will clip.
- [ ] **P1-12** Desktop: board stays visually dominant with the chat panel open and 30 messages.
- [ ] **P1-13** Contrast audit — `--dim: #5c5e5d` on `--night: #08090b` fails WCAG AA.
- [ ] **P1-14** Visual snapshot tests for lobby and room at 375, 667×375, 768, 1440.

## Phase 2 — Protocol v2

- [ ] **P2-01** Add `protocolVersion` to `server.hello` and to every client command; reject
      mismatches with an actionable message rather than a silent parse failure.
- [ ] **P2-02** Server-assigned monotonic `revision` on every authoritative game update.
- [ ] **P2-03** Server-assigned monotonic `sequence` on every chat event (messages, typing,
      reactions) — none exists today.
- [ ] **P2-04** Client discards any game or chat event not strictly newer than what it holds.
- [ ] **P2-05** Remove every client clock from ordering and deadline logic. `countdownEndsAt`
      and `reconnectDeadline` are currently absolute server epochs compared against `Date.now()`
      on the client; convert to server-relative durations plus a measured offset.
- [ ] **P2-06** Unify idempotency into one request ledger covering all commands, with TTL-based
      eviction replacing the 128-entry `Set` in `RoomManager.remember`.
- [ ] **P2-07** Idempotency test: every command type replayed twice produces exactly one effect.
- [ ] **P2-08** Harden Zod schemas; reject unknown fields, oversized frames and non-finite numbers
      at the edge.
- [ ] **P2-09** Fuzz suite: 10k randomised malformed frames, server must survive and reject cleanly.
- [ ] **P2-10** Compatibility matrix test: old client/new server and new client/old server both
      degrade with a clear message.

## Phase 3 — Chaos harness and property tests

- [ ] **P3-01** `?chaos=1` client-side chaos layer, development builds only, stripped from
      production output and verified absent by a test.
- [ ] **P3-02** Chaos knobs: 200–1200ms delay, ±400ms jitter, 5% outbound duplication,
      out-of-order acks, temporary disconnect, rapid reconnect, slow image chunks.
- [ ] **P3-03** Seeded deterministic RNG and injectable clock so chaos runs reproduce exactly.
- [ ] **P3-04** Headless chaos suite running full matches at 800ms latency / ±400ms jitter.
- [ ] **P3-05** Assert INV-1 … INV-6 from `INVARIANTS.md` continuously during chaos runs.
- [ ] **P3-06** Convergence assertion: after the network stabilises both clients hold identical
      authoritative state.
- [ ] **P3-07** Property-based tests over the pure engine — thousands of random move sequences,
      no invalid state reachable.
- [ ] **P3-08** Property-based tests over `RoomManager` including reconnects and rematches.
- [ ] **P3-09** Playwright scaffold: two browser contexts, real WebSocket, full match.

## Phase 4 — Presence, identity and socket ownership

- [ ] **P4-01** Server-authoritative presence state machine: `online → reconnecting → offline →
      expired`, with legal transitions enumerated and tested.
- [ ] **P4-02** Decide and document the multi-tab ownership policy (D-002).
- [ ] **P4-03** Implement it. Today `resumeSession` closes the older socket with code 4001; the
      chosen policy must be explicit and never create a duplicate player.
- [ ] **P4-04** Communicate ownership in the UI — the non-controlling tab states plainly that it
      is read-only and why.
- [ ] **P4-05** Cross-device session reclaim: laptop → phone with identical identity and mark.
- [ ] **P4-06** Separate host capability from player slot so the creator is not structurally
      special.
- [ ] **P4-07** Host migration: creator leaves, room survives, remaining player keeps playing.
      Currently `leaveRoom` destroys the room for both.
- [ ] **P4-08** Server restart behaviour: clients reach a clear "session lost" terminal state
      with a path to a new room, and never hang.
- [ ] **P4-09** Presence tests under chaos: rapid reconnect storms produce no duplicate players.

## Phase 5 — Optimistic UI with rollback

- [ ] **P5-01** Speculative local move application, visually distinct from confirmed state.
- [ ] **P5-02** Reconciliation against the authoritative revision; speculative state is always
      subordinate.
- [ ] **P5-03** Graceful rollback with an explanation on rejection — the rejected mark must never
      remain visible.
- [ ] **P5-04** Guarantee INV-2 (no client ever displays a server-rejected move) under chaos.
- [ ] **P5-05** Guarantee INV-1 (both players never simultaneously believe it is their turn).

## Phase 6 — Spectators and capability tokens

- [ ] **P6-01** Capability token model: `player`, `spectator`, `host`. Room-scoped, no accounts,
      no persistence.
- [ ] **P6-02** Server-side authorisation of every command by capability — never trust a
      client-sent role.
- [ ] **P6-03** Spectator join by room code when the room is full.
- [ ] **P6-04** Spectators cannot move, chat or react.
- [ ] **P6-05** Spectator privacy default: game state only. No chat, images or reactions on the
      wire unless host policy grants it.
- [ ] **P6-06** Host-grants-chat flow with revocation.
- [ ] **P6-07** Spectator presence visible to players; join/leave never disturbs the match.

## Phase 7 — Media pipeline, memory and backpressure

- [ ] **P7-01** Chunked image transfer with sequence numbers, per-chunk acks and timeouts,
      replacing the single Base64 frame.
- [ ] **P7-02** Per-room attachment budget: 10MB active media RAM.
- [ ] **P7-03** Process-wide attachment budget: 50MB.
- [ ] **P7-04** Exceeding a budget fails the upload gracefully with a specific rejection code —
      today the room limit silently evicts the oldest attachment instead.
- [ ] **P7-05** Backpressure: monitor `bufferedAmount`, define and enforce the slow-receiver
      policy so server RAM cannot grow unbounded.
- [ ] **P7-06** User-initiated upload cancellation; partial buffers freed on both ends.
- [ ] **P7-07** Incomplete and orphaned transfers discarded on disconnect and on timeout.
- [ ] **P7-08** Optional automatic content expiry — messages and images disappear after 5
      minutes even in an active room.
- [ ] **P7-09** Rate-limit intelligence: burst allowance plus sustained ceiling, so normal fast
      play is never throttled but a spammer is.
- [ ] **P7-10** Memory pressure test: 20 concurrent uploading rooms stay within budget; RAM
      returns to baseline after teardown.

## Phase 8 — End-to-end encryption and invitations

- [ ] **P8-01** Client-side room secret generation; secret lives only in the URL fragment.
- [ ] **P8-02** Verify the fragment is never transmitted — not in the WebSocket handshake, not
      in any frame, not in any header.
- [ ] **P8-03** AES-GCM E2EE for chat text with per-message IVs.
- [ ] **P8-04** E2EE for images, layered over the Phase 7 chunked transport.
- [ ] **P8-05** Key rotation on rematch and on session phase change; old keys destroyed.
- [ ] **P8-06** Test: post-rotation keys cannot decrypt pre-rotation ciphertext.
- [ ] **P8-07** Web Share API invite with clipboard fallback, fragment preserved intact.
- [ ] **P8-08** Locally generated QR invite — no external QR service, ever.

## Phase 9 — Match features

- [ ] **P9-01** Best-of-3 / best-of-5 ephemeral series with server-authoritative score.
- [ ] **P9-02** Series state survives reconnects and integrates with rematch.
- [ ] **P9-03** Optional 15s/30s turn timer, server-authoritative.
- [ ] **P9-04** Timer correctness: a backgrounded tab gains no extra time and loses none to
      browser throttling.
- [ ] **P9-05** Draw offer with accept/reject.
- [ ] **P9-06** Draw offer race safety — simultaneous offers and offer-vs-move resolve cleanly.
- [ ] **P9-07** Near-simultaneous rematch votes produce exactly one transition.
- [ ] **P9-08** In-session replay animation, destroyed with the room, never persisted.

## Phase 10 — Generated identity and procedural arena

- [ ] **P10-01** Deterministic identity generation: avatar, accent, symbol from the session seed.
- [ ] **P10-02** Determinism test: same seed → identical identity.
- [ ] **P10-03** Textual identity parity — every visual has a name and description; identity is
      never visual-only.
- [ ] **P10-04** Subtle procedural arena variation from both players' seeds, bounded so rooms
      stay recognisably one product.
- [ ] **P10-05** Reactions animate from the opponent's identity position toward the arena.
- [ ] **P10-06** Test: the reaction path never occludes a playable cell.

## Phase 11 — Accessibility, motion, mobile and PWA

- [ ] **P11-01** Full keyboard operation of game and chat, including the picker and image flow.
- [ ] **P11-02** Screen reader announcements for turn change, move placed, result, presence
      change and incoming message — polite vs assertive chosen deliberately.
- [ ] **P11-03** Replace the blanket reduced-motion kill switch with a designed reduced-motion
      state.
- [ ] **P11-04** Reduced-motion visual review at every phase transition.
- [ ] **P11-05** 667×375 landscape fully usable.
- [ ] **P11-06** 375px one-thumb switching between game and conversation without losing context.
- [ ] **P11-07** Desktop board dominance verified with 30 chat messages.
- [ ] **P11-08** Installable PWA — manifest, icons, install prompt.
- [ ] **P11-09** Offline honesty: an installed PWA opened offline must not pretend multiplayer
      is available.
- [ ] **P11-10** Automated a11y scan clean on lobby and room.

## Phase 12 — Privacy audit, log audit and full E2E

- [ ] **P12-01** Repository audit: every occurrence of `localStorage`, `sessionStorage`,
      IndexedDB, `fs` writes, database clients, object storage and analytics, with a verdict
      on each.
- [ ] **P12-02** Runtime audit: confirm no temporary upload directory or filesystem write path
      exists on the server.
- [ ] **P12-03** Re-verify the two known browser storage uses are content-free:
      `sessionStorage` session handle and `localStorage` mute preference.
- [ ] **P12-04** Automated no-content log test: full match with chat and images, capture all
      `console.*` and server log output, assert no message body or image byte appears.
- [ ] **P12-05** Two-browser E2E for the complete flow.
- [ ] **P12-06** Network-interruption E2E: cut and restore the socket mid-match.
- [ ] **P12-07** Full chaos matrix at maximum severity in CI.
- [ ] **P12-08** Publish the audit report with evidence — code references and test names, not
      assurances.
