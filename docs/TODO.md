# Gridline TODO

The single source of truth for what is done. IDs are stable and permanent — reference them
in commits (`P1-01: give the board explicit grid rows`).

Status: `[ ]` not started · `[~]` in progress · `[x]` done and tested · `[!]` blocked

**All thirteen phases are closed** as of 2026-10-09. Every task below is done and has a test
behind it; the reasoning for each sits beside it rather than in a commit message nobody will
read again. What remains open is listed in [DECISIONS.md](./DECISIONS.md) and in the S3 section
of [UX_AUDIT.md](./UX_AUDIT.md) - neither blocks anything shipped.

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
- [x] **P0-07** `npm run test:e2e` (Playwright) and `npm run test:chaos` (chaos + property
      suites) added in Phase 3, alongside the suites they invoke.

## Phase 1 — UI/UX foundation

- [x] **P1-01** **Board geometry.** `grid-template-rows: repeat(3, 1fr)` added to `.game-board`
      and `.teaser-board`; cells given `min-height: 0`. Root cause of the "gridline moves until
      all boxes are filled" bug.
- [x] **P1-02** Both halves now land. Structural assertions in `tests/styles.test.ts`, and the
      pixel-measured proof in `e2e/layout.spec.ts`: every cell square and equal on an empty
      board, and no cell moving by more than 1px across a full nine-mark draw. A second test
      measures that adjacent cell edges meet, so the gridlines provably sit on the boundaries.
- [x] **P1-03** Gridlines moved off the background gradient onto cell-derived borders
      (`.game-cell:not(:nth-child(3n))` / `:nth-child(-n+6)`), so lines and cells cannot drift.
- [x] **P1-04** Type scale defined as tokens: `--text-micro` (11px, decorative only) through
      `--text-lg`, plus `--tap: 44px`.
- [x] **P1-05** All sub-12px font declarations migrated. A test now fails the build on any
      literal font size below 12px.
- [x] **P1-06** `font-size: 0` label-hiding replaced with a `.btn-label` collapse utility that
      keeps the text in the accessibility tree. Applied in GameApp, ConnectionBadge and GameRoom.
- [x] **P1-07** Mobile tap targets raised to `var(--tap)` (44px) for copy/chat/leave, the chat
      send button, composer tools and the image-preview close button.
- [x] **P1-08** `.game-status` given a fixed height and `.status-copy p` a reserved two-line box,
      so neither wrapping copy nor the rematch button can nudge the board.
- [x] **P1-09** **Withdrawn — not a defect.** The geometry works out to `0.9214S` on a board of
      side `S`, comfortably inside the box. See UX_AUDIT S2-E for the working. No change made.
- [x] **P1-10** 375×667 portrait measured in a real browser: no horizontal overflow, board
      square and above 240px, and every room control at or above the 44px tap target.
- [x] **P1-11** 667×375 landscape breakpoint added — three-column arena, board sized from
      viewport height, status compressed to one line. The board could previously compute a
      negative width there.
- [x] **P1-12** Board dominance holds by construction: the chat panel is fixed-position at a
      fixed width and its message list scrolls internally, so message count cannot feed back
      into board size. Asserted by test.
- [x] **P1-13** Contrast audit done by computation, not by eye. Thirteen colours were below
      4.5:1 (worst 2.57:1); all now pass, and the test recomputes every ratio on each run.
- [x] **P1-14** Covered at all four viewports by *measured* assertions rather than pixel
      screenshots — geometry, overflow, computed font sizes, tap targets. Screenshot baselines
      differ across operating systems and font stacks, so a committed baseline would have been a
      CI flake generator rather than a safety net. Recorded as a deliberate substitution.

## Phase 2 — Protocol v2

- [x] **P2-01** `PROTOCOL_VERSION = 2`. `server.hello` advertises `protocolVersion` and
      `minClientProtocol`; every client command carries an optional `protocolVersion` whose
      absence is read as v1, so a pre-versioning client is still served (D-004). Out-of-range
      clients get `PROTOCOL_MISMATCH` with an actionable message and the socket stays usable.
- [x] **P2-02** `RoomSnapshot.version` renamed to `revision` — the old name collided with
      `protocolVersion` in the same file. Strict monotonicity asserted by test.
- [x] **P2-03** One monotonic `sequence` per room across all chat events. Messages carry it in
      `ChatMessageSnapshot`; typing, message reactions and quick reactions carry it on the
      envelope; `ChatSnapshot.sequence` restores stream position on resume.
- [x] **P2-04** Client discards stale updates — but only where discarding is correct. Game
      snapshots and the two state-overwriting chat events are dropped when not newer; chat
      *messages* are never dropped for lateness, only inserted at their sequence position.
      Dropping them would lose data, which is not what the ordering guarantee asks for.
- [x] **P2-05** Every absolute epoch removed from the authoritative snapshot. Deadlines travel
      as durations in a separate `timing` envelope, and the countdown renders from
      `performance.now()`. No client clock participates in ordering or in any deadline.
- [x] **P2-06** Per-player `Map` ledger with a 120s TTL and a 512-entry backstop, replacing the
      128-entry `Set` and the O(n) `findDuplicateMessage` scan. The ledger records what a replay
      should return, and is consulted *before* the rate limiter so a legitimate retry is not
      punished.
- [x] **P2-07** Replay tested for move, chat message, sticker path, message reaction, quick
      reaction and rematch vote — each produces exactly one effect.
- [x] **P2-08** Unknown fields, non-finite numbers and oversized frames all rejected at the edge.
- [x] **P2-09** 10,000 seeded malformed frames delivered in bursts across fresh sockets; the
      server survives and still serves the next valid command.
- [x] **P2-10** Full skew matrix unit-tested by extracting the decision into
      `app/lib/protocolCompatibility.ts`: agreement, legacy server, malformed version, client
      behind, client ahead, and unsupported client.

## Phase 3 — Chaos harness and property tests

- [x] **P3-01** `?chaos=1` transport in `app/lib/chaos.ts`, loaded through a dynamic import
      behind an inlined `NODE_ENV` guard. **Genuinely stripped**, not merely disabled: the first
      attempt put the guard in a helper function, the minifier could not prove the branch dead,
      and the chunk shipped. A test greps the built output for a marker string and, in CI, fails
      rather than skips when `out/` is missing.
- [x] **P3-02** Per-frame independent delay, jitter, duplication, loss and abrupt disconnect.
      Reordering emerges from the independent delays rather than being injected separately,
      which is how a genuinely variable link behaves.
- [x] **P3-03** mulberry32 seeded RNG in `shared/chaos.ts`, shared by the browser transport and
      the headless simulation. Vitest fake timers supply the clock, so RoomManager's own
      countdown and sweep timers run on the same virtual clock as the chaos scheduler.
- [x] **P3-04** `tests/support/simulation.ts` runs the real RoomManager through the real command
      dispatcher against clients using the real ordering rules. Only the transport and the move
      choice are simulated.
- [x] **P3-05** INV-1, INV-2, INV-4 and INV-6 asserted after every delivered event, not just at
      the end. **This caught a real bug** — see PROGRESS and INV-1.
- [x] **P3-06** Convergence asserted across 200 seeded runs at 800ms ±400ms: all 200 finish and
      all 200 converge to byte-identical state.
- [x] **P3-07** 5,000 seeded move sequences against the pure engine over eight structural
      properties, plus 1,000 sequences asserting every illegal move is refused from every
      reachable state.
- [x] **P3-08** 500 hostile command sequences against RoomManager (stale revisions, duplicate
      request ids, out-of-turn moves, votes at the wrong time) and 200 runs asserting two peers
      never diverge.
- [x] **P3-09** Playwright scaffold with two browser contexts and the real WebSocket: full match
      synchronisation, INV-1 under real UI gating, reload recovery, unknown room code, and a
      genuine transport cut via `routeWebSocket`.
- [x] **P3-10** `P1-02`, `P1-10` and `P1-14` all closed in `e2e/layout.spec.ts`.

## Phase 4 — Presence, identity and socket ownership

- [x] **P4-01** `PresenceState` is derived from connections and the clock, never stored, so it
      cannot drift from what defines it. **The sweep announces drift**: the move from
      `reconnecting` to `offline` is the passage of time with no event to carry it, so without
      that the opponent would sit on "Reconnecting…" forever — correct on the server, wrong on
      every screen. Caught by a test.
- [x] **P4-02** Policy decided and documented (D-002, 2026-08-31): **newest connection takes
      control, displaced connection becomes explicitly read-only** rather than disconnected.
- [x] **P4-03** A player now holds `connections: Map<peerId, Peer>` and a `controllingPeerId`.
      `resumeSession` attaches and grants control instead of closing with 4001; every mutating
      command goes through `requireControl` and a read-only window gets `NOT_IN_CONTROL`.
      Control also passes to a surviving window when the controller disconnects, so losing one
      tab of two does not pause the match.
- [x] **P4-04** `.control-banner` says it in words and offers **Take control here**. The board
      stays fully legible and live rather than greyed out — the demoted window keeps watching,
      which is the point. The claim is a `session.claim` command; a two-window race is tested
      to produce exactly one winner.
- [x] **P4-05** Tested: laptop drops, phone resumes by token with the same `playerId`, display
      name and mark, takes control, and the room still holds exactly two players.
- [x] **P4-06** `Room.hostPlayerId` plus `isHost` in the snapshot. The capability carries no
      powers yet — those arrive with the token model in Phase 6 — but the migration has to exist
      before anything can depend on it.
- [x] **P4-07** `leaveRoom` frees one slot instead of destroying the room; host migrates, the
      board resets to `waiting`, and the room stays joinable. Chat is purged on departure — it
      was private to the two people in it. **This surfaced a real bug**: `joinRoom` handed out
      `'O'` unconditionally, so once an X could leave a surviving room the newcomer became a
      second O and nobody held the turn. It now takes whichever mark is free.
- [x] **P4-08** Tested across an actual process restart on the same port: the old token is
      refused with `ROOM_NOT_FOUND` and the same socket can immediately open a new room, so the
      client is never stuck retrying a dead token (D-003).
- [x] **P4-09** A twelve-window reconnect storm on one token: still exactly one player, exactly
      one window holding the slot, and a bystander's move refused with `NOT_IN_CONTROL`. Plus a
      burst-closure test proving presence stays `online` while any window survives.

## Phase 5 — Optimistic UI with rollback

- [x] **P5-01** `app/lib/speculation.ts` holds the rules as pure functions; the board renders
      `projectBoard(snapshot.board, speculation)`. An unconfirmed mark is legible but lighter,
      with a slow breath and an underline — deliberately not ghostly, since the player made a
      real decision that will almost always stand. Its `aria-label` says "sending".
- [x] **P5-02** `reconcile()` asks what the newer board *shows*, not how far the revision moved,
      because a move and the opponent's reply can arrive together. The overlay never covers a
      square the server has already filled — the authority wins on the spot rather than waiting.
- [x] **P5-03** One function, `settleSpeculation`, is the only path by which an optimistic mark
      disappears, so INV-2 is a statement about it. Rollback carries the server's own reason where
      there is one. Every failure path is covered: explicit rejection, a newer board without our
      mark, losing the window's control, and silence — an unacknowledged move is withdrawn after
      five seconds, because silence is not confirmation.
- [x] **P5-04** The chaos simulation now speculates using the real functions, and **INV-2 is
      measured against the visible board rather than the snapshot** — checking the snapshot alone
      would have made the invariant vacuous the moment speculation existed, since the snapshot is
      server-supplied by construction. 200 seeded runs at 800ms ±400ms, no violations, and
      nothing optimistic survives the drain.
- [x] **P5-05** `canPlay()` gates acting, and an outstanding speculation blocks a second move —
      without that a player could place two marks against a board the server has not seen.
      Asserted exhaustively over every turn/phase combination, in the chaos runs, and in a real
      browser.

## Phase 6 — Spectators and capability tokens

- [x] **P6-01** `Capability = 'player' | 'spectator'`, with host as a capability on a player
      slot (Phase 4). Room-scoped and ephemeral: a spectator holds **no token at all** and cannot
      resume, which is what keeps it genuinely a different thing rather than a player with fewer
      permissions — there is no identity worth reclaiming, so reconnecting just means watching again.
- [x] **P6-02** `requireMembership` now recognises a spectator and refuses with `FORBIDDEN`
      rather than the confusing and untrue `NOT_IN_ROOM`. Tested with hand-written frames that
      bypass any client-side check.
- [x] **P6-03** `room.spectate`. Refused with `ROOM_NOT_FULL` when a seat is still open — a room
      waiting for a second player wants a player, not an audience.
- [x] **P6-04** Move, chat, reaction, rematch vote and control claim all refused.
- [x] **P6-05** Withheld at the source: with chat closed a spectator's socket never carries the
      frame, so there is nothing a patched client could reveal. The test reads the socket rather
      than the screen and asserts the message text appears nowhere in it.
- [x] **P6-06** `room.policy`, host-only — the guest's attempt is refused with `FORBIDDEN`.
      Revocation takes effect immediately; the next message does not reach the watcher.
- [x] **P6-07** `spectatorCount` in the authoritative snapshot, with a host-only banner offering
      the policy toggle. Joining and leaving leave the phase and both player slots untouched.

## Phase 7 — Media pipeline, memory and backpressure

- [x] **P7-01** `chat.image.begin` / `chat.image.chunk` / `chat.image.cancel`, 64KB chunks, with
      `upload.progress` acknowledging each one so a stall is visible rather than silently pending.
      The idle timeout restarts on every chunk, so it measures *silence* rather than duration — a
      slow but live upload is not punished for being slow.
- [x] **P7-02** 10MB per room, reserved at `begin` rather than at completion — a dozen
      half-finished uploads would otherwise sit in memory entirely unaccounted for.
- [x] **P7-03** 50MB process-wide, **computed** from live rooms rather than kept as a running
      total. A counter drifts the first time a cleanup path forgets to decrement it, and the drift
      only surfaces much later as a mysterious refusal.
- [x] **P7-04** `MEMORY_BUDGET`, and the earlier images stay (D-006). Byte-based eviction is
      gone: a picture vanishing from the conversation with no explanation reads as data loss.
- [x] **P7-05** Past 1MB buffered, only `game.snapshot` and `session.ready` are forced through —
      they are small and a client that misses one shows a stale board. Past 8MB the connection is
      closed, because it now costs more memory than it is worth and the client's own reconnect is
      the cheaper recovery.
- [x] **P7-06** `chat.image.cancel`, and the client stops between chunks rather than finishing
      the send and discarding the result afterwards.
- [x] **P7-07** `discardUpload` is the single path by which upload memory is released; room
      teardown and the idle timeout both go through it.
- [x] **P7-08** Host-enabled, five minutes, swept against the room's own clock. **Announced**
      via `chat.expired` rather than dropped silently, so clients revoke the blob URLs they hold —
      otherwise the bytes outlive the server's copy inside the browser, which is exactly where an
      ephemerality claim would quietly become false.
- [x] **P7-09** Token buckets replace the flat sliding window, which could not tell an
      enthusiastic player from a spammer — twelve messages in eight seconds throttled both. Burst
      is what is forgiven; refill is what can be sustained forever. Evidenced by the Phase 3 run
      where a paced 30-message test was cut off at 24.
- [x] **P7-10** Budget ceilings are injectable (`roomImageLimitBytes`), so the refusal path is
      tested by reaching a real limit rather than pushing ten megabytes through a socket to prove
      a rule about arithmetic. Teardown is asserted to leave no partial upload behind.

## Phase 8 — End-to-end encryption and invitations

- [x] **P8-01** 32 random bytes, generated in the browser before the room exists and placed in
      the URL **fragment**. A fragment is stripped before the request leaves the machine; a query
      string is not. The old invite link used `?room=` — correct for a code, fatal for a key.
- [x] **P8-02** Asserted by transcript, not by inspection: the socket tests keep every frame the
      server received and search it for the plaintext and for the secret. That is the only form of
      this claim a patched client cannot talk its way out of.
- [x] **P8-03** AES-GCM, 256-bit, with a fresh 96-bit IV per message. Keys come from
      HKDF-SHA256 over the room secret, salted with the room code and labelled with the epoch, and
      are derived **non-extractable** so not even our own code can read them back out.
- [x] **P8-04** Sealed before chunking rather than per chunk: one authentication tag over the
      whole image means a truncated or reordered upload fails to open instead of decrypting into a
      partial picture. The consequence is that the server can no longer sniff the format, so
      `inspectImage` moved to `shared/` and now runs on the receiving client after decryption —
      the check did not get weaker, it moved to the only party still able to perform it.
- [x] **P8-05** The epoch increments when a player arrives and on every rematch. Nothing is
      exchanged: both sides derive generation *n* from the secret they already hold, so the server
      names the generation without ever being able to compute a key. Exactly one generation is held
      client-side, so deriving the next destroys the previous (D-010).
- [x] **P8-06** Tested both ways — the new key cannot open the old ciphertext *and* the old key
      still can, which is what makes the first assertion about rotation rather than about a broken
      derivation. Also tested across rooms: the same secret in a different room derives a different
      key, so an invite link pasted into the wrong room fails loudly.
- [x] **P8-07** Share sheet, then clipboard, then the link on screen as the floor. A dismissed
      share sheet rejects exactly like a failure and must not be reported as one, so both fall
      through to the clipboard — and the link stays visible because a share target that re-encodes
      a URL is precisely how a fragment gets lost.
- [x] **P8-08** A QR encoder written in-repo (`app/lib/qr.ts`): byte mode, EC level M, versions
      1–10, with the specification's four penalty rules used to pick the mask. Every hosted
      generator works by being *sent* the thing to encode, which for this URL means handing over
      the room key — the one piece of this phase that looked like a UI detail was the piece that
      would have undone the rest. Tested by decoding the symbol back with an independent reader at
      every supported version.

## Phase 9 — Match features

- [x] **P9-01** The score lives on the server, keyed by **player id and not by mark** — marks
      swap on every rematch, so a score kept against a mark would change hands with it. A single
      game is the default: a series is opted into, not something two strangers are signed up to
      before they have played once.
- [x] **P9-02** It survives a reconnect because it was never on the client. The format is locked
      once a round has been decided and open before that, which is the same rule the UI shows — a
      control that vanished when the round began would forbid something the server allows.
      Changing the turn limit mid-round **re-arms** the clock rather than truncating a turn
      someone is already thinking through.
- [x] **P9-03** 15s or 30s, enumerated in the protocol rather than taken as a number: a limit
      short enough to be unplayable is a way to grief an opponent. The deadline leaves the server
      as a *duration* (INV-11), and `turnLimitOverrideMs` lets a test reach a real expiry without
      waiting fifteen real seconds.
- [x] **P9-04** The turn **passes**; the round is not forfeited (D-012). Losing a game to a phone
      that locked its screen is a worse outcome than losing a move, and a player who keeps running
      out loses anyway by never placing a mark. Verified in Playwright by genuinely backgrounding
      a tab — the one condition a client-side countdown cannot survive, since Chromium throttles
      its timers. The expiry is **announced** (`turn.expired`): the board does not change, so
      without it the turn would have moved for no visible reason.
- [x] **P9-05** `draw.offer` / `draw.respond`, with the decline announced because acceptance is
      visible as a drawn board and a decline is not.
- [x] **P9-06** Three races, three answers (D-013). Simultaneous offers are an **agreement**, not
      a race: the second offer finds the first outstanding and settles the draw, because refusing
      it would throw away what both players just said. Playing on **withdraws** the offer —
      otherwise a player could accept a draw in a position that no longer exists. And a response
      carries the round it answers, so an acceptance in flight when the round ended cannot draw
      the next one.
- [x] **P9-07** Already structurally safe through the vote set; now asserted. Duplicate and
      simultaneous votes produce exactly one round transition, with the whole snapshot history
      checked for an intermediate round nobody should have seen.
- [x] **P9-08** The move history is in the snapshot, so a window that reconnected mid-round can
      still replay it. Replay is **derived** from the phase and a step index rather than stored:
      if the room moves on, the replay stops being true and the live board returns with nothing to
      unwind, which an effect clearing the state would have had to race.

## Phase 10 — Generated identity and procedural arena

- [x] **P10-01** Accent, symbol and a 5×5 sigil, derived from the **player name** rather than
      from the player id. Three consequences, all of them the point: both clients derive the same
      identity with **nothing new on the wire** — this phase changes no protocol, so there is no
      skew window between the two deploys (D-008); the identity visibly belongs to the name the
      player is shown rather than to a hidden id; and nothing is stored, so there is no identity
      record to persist, leak or expire.
- [x] **P10-02** Asserted across all 480 names the server can issue, not on an example — which
      is how the one real bug in this phase was found. `^` in JavaScript yields a *signed* 32-bit
      integer, so the hash mixer produced a negative remainder for roughly half of all seeds, a
      negative array index, and an `undefined` accent. Spot checks would have caught it half the
      time.
- [x] **P10-03** Every accent has a name and every symbol a label, and the description that
      carries both is what the sigil announces as its `aria-label`. The palette is **fixed rather
      than generated** precisely so contrast can be asserted: a random hue eventually produces an
      identity colour that cannot be read, which is an identity that cannot be read.
- [x] **P10-04** Derived from both names **sorted**, so the arena belongs to the match rather
      than to whoever opened the room, and so the two players cannot see different rooms. The
      bounds are declared as constants and asserted, because the tempting change later is to widen
      them "just a little" until two rooms stop looking like one product.
- [x] **P10-05** Reactions arrive from the sender's own side of the arena, positioned from
      `reactionPath` — arithmetic in board widths, with CSS interpolating between the endpoints the
      function returns.
- [x] **P10-06** Proved rather than eyeballed. The path is a function, so the test walks a
      thousand points along it for both sides and asserts the **whole glyph box** clears the 3×3
      region with margin. Progress is clamped, so a timer that overruns by a frame cannot fling the
      glyph across the board the way an unclamped interpolation would. On narrow screens the cards
      stack and there is no room beside the board, so the glyph rises from above the frame instead
      — still never over a cell, which is the actual requirement.

## Phase 11 — Accessibility, motion, mobile and PWA

- [x] **P11-01** The whole journey without a mouse: create, invite, play, chat, send, close, play
      on. Escape closes the innermost thing first — picker, then preview, then the panel — because
      closing everything at once is what makes a keyboard user lose their place. Closing returns
      focus to the control that opened the panel, and opening moves focus into the composer, done
      from the opening gesture rather than from an effect inside the panel: the click that opens it
      also focuses the toggle, and that default lands *after* React commits, so an effect wins the
      race and then quietly loses it.
- [x] **P11-02** Two live regions, both **derived during render** with no state and no effects — a
      live region announces when its text changes, so a pure function of the authoritative snapshot
      cannot drift from the screen or double-announce. Polite carries the turn, the move just
      played, presence and an incoming message; assertive carries only the result, the series and
      losing the network, because every assertive announcement cancels the one before it. Message
      bodies are never read aloud: in an encrypted room the text may be unreadable anyway, and
      reading every message over a live game is more interruption than it is worth.
- [x] **P11-03** The blanket `animation-duration: .01ms !important` is gone (S1-C closed). What
      replaces it keeps the two things that carry meaning — that something changed, and which thing
      — and removes the two that carry only style: travel and scale. Opacity and colour still
      transition, shortened; entrances become crossfades; the reaction sits at the end of its path,
      which is the position already proved clear of the cells (INV-16).
- [x] **P11-04** Every phase transition reviewed in the reduced state: countdown, mark placement,
      the winning line, the replay, reactions, the chat panel. Each either keeps a non-moving
      emphasis or is removed outright — nothing was left snapping, which is what the kill switch
      produced and what reads as a broken interface rather than a calm one.
- [x] **P11-05** 667×375 and anything near it gets its own rules. The vertical budget is the whole
      problem, so the chrome gives up height and the board keeps its size; the chat panel takes a
      side rather than the screen, because covering a landscape board means losing the game to read
      a message.
- [x] **P11-06** At 375px both controls sit in the bottom corner inside the safe-area inset, within
      a thumb's reach. The board is never unmounted behind the panel, so switching back restores
      the same board and the same scroll position — it never went away.
- [x] **P11-07** Asserted with thirty real messages: the board's width does not change as the
      conversation grows. Writing that test turned up a second finding — thirty messages fired
      instantly are *correctly* throttled by the Phase 7 token bucket, so the first version of it
      was measuring the rate limiter rather than the layout.
- [x] **P11-08** Manifest, service worker and icons, all hand-written. The icons are drawn by
      `scripts/generate-icons.mjs`: a PNG is a signature, three chunks and a CRC, and the
      alternative was an image dependency this project does not otherwise need. Output is
      committed, so no build depends on running it.
- [x] **P11-09** Navigations are **network-first**, which the usual cache-first template gets
      exactly backwards twice over: it pins installed users to a stale build, and it makes an
      offline app look like a working one. `navigator.onLine` is treated as a *diagnosis*, never a
      gate — the first version gated connection attempts on it and produced precisely the failure
      this task is about, a device whose link came back sitting offline forever because the only
      thing that would have noticed was the attempt it was refusing to make. A link drop does not
      always close a socket, so coming back re-derives the state instead of assuming it.
- [x] **P11-10** axe-core over the lobby, the room and the room with chat open. It found a real
      defect no review had: `role="gridcell"` with no `role="row"` between the cells and the grid.
      Fixed with row wrappers at `display: contents`, which leaves the CSS grid untouched and gives
      the accessibility tree the structure the role promises.

## Phase 12 — Privacy audit, log audit and full E2E

- [x] **P12-01** Done as an executable inventory rather than a document
      (`tests/privacy.test.ts`): one rule per category — `localStorage`, `sessionStorage`,
      IndexedDB, the Cache API, cookies, the filesystem, database clients, object storage,
      analytics — each with an allowlist. A new place that could retain content fails the suite and
      has to be argued for in the report before it can ship. Comments are stripped before scanning,
      because an explanation of why something is *not* used must not read as a use of it.
- [x] **P12-02** No filesystem path exists in `server/` at all — no `node:fs`, no temp directory,
      no upload directory. That is a consequence of the Phase 7 design rather than an omission:
      chunks are assembled in memory, and the conventional write-assemble-unlink shape is the one
      that leaves attachments on a disk after a crash.
- [x] **P12-03** Both browser stores re-verified against the bytes they actually write. The
      session handle is compared *whole*, so a field added later cannot ride along unnoticed, and
      the room key is asserted absent — it lives in the URL fragment and in memory, and a second
      copy in storage would outlive the tab that earned it.
- [x] **P12-04** `tests/logAudit.test.ts` plays a full match — sealed text, a sticker, a quick
      reaction, a sealed image over the chunked transport, five moves, a malformed frame and a
      refused command — with every `console.*` channel **and** the raw `process.stdout`/`stderr`
      writes captured. It asserts the output contains none of the plaintext, none of the
      ciphertext (a log of unreadable bytes is still a log of the conversation, and it would
      outlive the key), no image data, no secret, no token — and in fact **nothing at all**. "It
      did not log the secret" is weaker than "it did not log", and the second is the claim this
      product makes. The malformed frame is deliberate: an error handler that serialises what it
      choked on is the leak a code reading would miss.
- [x] **P12-05** `e2e/journey.spec.ts` does what two people actually do: open a room, send the
      link, join by link, talk both ways, play, check the score on both screens, rematch, leave —
      and confirms the room survives the leaver.
- [x] **P12-06** The same file cuts the network mid-match. `context.setOffline` turned out to be
      the wrong tool and finding that out was the point: it drops the link without closing an open
      socket, so the opponent never learns anything happened. `e2e/support/cutSocket.ts` closes the
      socket from inside the page and refuses new connections until restored, which is an
      interruption the server actually sees.
- [x] **P12-07** Six network profiles, forty seeds each, 240 matches, every invariant and full
      convergence asserted on every run. Gated behind `GRIDLINE_CHAOS_MATRIX` so CI runs it on
      every push while a developer running the suite locally does not wait on it to learn their
      typo is a typo.
- [x] **P12-08** [`docs/PRIVACY_AUDIT.md`](./PRIVACY_AUDIT.md), written as evidence: every claim
      names a file you can read or a test you can run, the known limits are stated plainly rather
      than omitted, and the last section is how to re-run the whole thing.
---

## Phase 13 — Solo play, and a room with an audience that can join it

- [x] **P13-01** Runs entirely in the browser: no room, no socket, no board on a server. A solo
      game has no second person in it, so there is nothing for an authority to arbitrate — and the
      room machinery never has to learn about a player who is not a person. It works with the
      network off, which is also when it is most wanted, and the offer is shown even while the
      connection is down.
- [x] **P13-02** Four levels that decide in different terms rather than one engine behind a dial:
      Casual does not look ahead at all, Keen looks exactly one move ahead, Sharp searches and
      slips once in five, Flawless searches. A single strong engine with a "mistake chance" plays
      perfectly and then throws the game away, which reads as a cheat rather than as a weaker
      opponent — so Sharp's slip is the best of what is left after discarding the strongest move,
      not a random cell. **Flawless is proved unbeatable by playing every game a human could
      play against it**, not by playing it a few times. Minimax scores by depth, so it takes a win
      now over the same win in three moves — without that it looks like it is toying with you.
- [x] **P13-03** Winning steps up, losing steps back, a draw holds — against the top level a draw
      is the best result there is, and demoting someone for it would be absurd. The level and the
      record live in memory only: persisting them would mean a new browser-storage key, which the
      privacy audit would fail, correctly. The ladder resetting when you leave is the honest
      version of a product that claims to leave nothing behind.
- [x] **P13-04** Opening an invitation when the room is full makes you a watcher instead of
      sending you back to the lobby to press "watch instead" — the decision was already made by
      opening the link. Typing a room code by hand still offers the choice, because there the
      person may well have meant to play.
- [x] **P13-05** The link carries the key to whoever opens it, so watchers can read and write.
      Spectator chat is now **on by default**, reversing the Phase 6 choice deliberately (D-015):
      that default protected watchers from overhearing a room they could not otherwise reach, and
      one link now carries everyone, so withholding it protects nothing and only makes the room
      feel like two rooms. The host can still close it, and closing still withholds the frames
      rather than hiding them in the UI.
- [x] **P13-06** The count is in the room for everyone, players included.
- [x] **P13-07** Asking twice is asking once, and keeps the original place — the queue is
      ordered by who asked first, not by who asked most recently. A watcher who leaves takes their
      request with them, or the host is offered a seat for somebody who is not in the room.
- [x] **P13-08** Between rounds only, and the control is shown disabled with the reason rather
      than hidden. Swapping mid-round would hand someone a position they did not choose to enter,
      and queueing the change until the round ends would spring a decision made minutes earlier on
      a room that had stopped expecting it. Seating starts a **new series**: carrying the score
      forward would credit the newcomer with rounds somebody else lost.
- [x] **P13-09** Resolved by the server when the message is stored, not looked up when it is
      read. The sender may be a watcher who was never in the player list, or a player who has
      since been seated out — and their earlier words should not lose their name because of what
      happened to them afterwards.
- [x] **P13-10** 264 unit tests and 7 new browser specs, including the whole flow end to end:
      one link opened four times, a watcher asking, the host seating them between rounds, and the
      conversation staying attributed across the swap.
