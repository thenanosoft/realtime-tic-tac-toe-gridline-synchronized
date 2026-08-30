# Invariants

Properties that must hold at every instant, under every network condition. These are not
goals — they are the definition of correctness. Every one has, or will have, a test that
defends it. The chaos suite (`P3-05`) asserts INV-1 … INV-6 continuously during runs.

**Status after Phase 2.** INV-4, INV-5 and INV-11 are defended by tests in
`tests/protocol.test.ts` and `tests/compatibility.test.ts`. INV-3 is defended for the
single-connection case — two clients at the same revision are asserted deep-equal — but its
full form, convergence *after* a network disturbance, needs the Phase 3 chaos harness. The
rest are open.

---

### INV-1 — Turn exclusivity
At no point may both clients believe it is their turn.

*Defended by:* `P5-05`, chaos suite.
*How it breaks:* an optimistic turn flip applied locally while a rejection is in flight.

### INV-2 — No phantom moves
At no point may a client display a move that the authoritative server has rejected.

*Defended by:* `P5-03`, `P5-04`, chaos suite.
*How it breaks:* speculative rendering without a rollback path, or a rollback that races a
newer snapshot.

### INV-3 — Convergence
After connectivity stabilises, all clients in a room converge to exactly the same
authoritative state within one round trip.

This is why `RoomSnapshot` is a pure function of the room at a revision and why everything
time-dependent was moved into a separate `timing` envelope in Phase 2: a snapshot carrying
decaying durations can never be compared between two clients, so the invariant would have been
untestable by construction.

*Defended by:* `P3-06`; partially by the same-revision equality test added in Phase 2.
*How it breaks:* a dropped snapshot with no resync, or a client that applies events it
should have discarded.

### INV-4 — Monotonic authority
A client never applies a game update with `revision` ≤ its current revision, nor a chat
event with `sequence` ≤ its current sequence for that stream.

*Defended by:* `P2-02`, `P2-03`, `P2-04`.
*How it breaks:* out-of-order delivery on reconnect, when a resume snapshot and a live
broadcast race.

### INV-5 — Exactly-once effects
A command replayed with the same `requestId` produces exactly one effect, regardless of how
many times it arrives or through how many sockets.

*Defended by:* `P2-06`, `P2-07`.
*How it breaks:* a duplicate emitted by the chaos layer, or a client retry after a timeout
that was actually delivered.

### INV-6 — One human, one player
A single session never appears as two players, and two connections never simultaneously hold
control of one player slot.

*Defended by:* `P4-03`, `P4-09`.
*How it breaks:* a second tab resuming while the first is mid-reconnect.

### INV-7 — Bounded memory
Per-room attachment memory never exceeds 10MB; process-wide never exceeds 50MB. Memory
returns to baseline after a room is destroyed or an upload is abandoned.

*Defended by:* `P7-02`, `P7-03`, `P7-10`.
*How it breaks:* orphaned partial upload buffers, or a slow receiver whose send queue grows
without bound.

### INV-8 — No plaintext at rest or in logs
No message body and no image byte is ever written to disk, to a database, to browser
persistent storage, or to any log or console line — on either side.

*Defended by:* `P12-01` … `P12-04`.
*How it breaks:* a debug log added during development and never removed; an error handler that
serialises the whole frame.

### INV-9 — Server holds no room secret
From Phase 8 onward, the server never receives the room secret in any form — not in a
handshake, a frame, a header, a query string or a referrer.

*Defended by:* `P8-01`, `P8-02`.
*How it breaks:* moving the secret out of the URL fragment into a query parameter, or logging
`window.location.href`.

### INV-10 — Capability enforcement is server-side
A spectator's forged `game.move` or `chat.message` is rejected by the server. Client-side role
checks are convenience only.

*Defended by:* `P6-02`, `P6-04`.
*How it breaks:* trusting a role field sent by the client.

### INV-11 — Clock independence
A wrong client clock never affects ordering, turn deadlines, or any server-enforced timeout.

*Defended by:* `P2-05`, `P9-04`.
*How it breaks:* comparing a server-supplied absolute epoch against a skewed local
`Date.now()` — which is what `countdownEndsAt` and `reconnectDeadline` do today.

### INV-12 — Honest availability
The client never presents multiplayer as available when it is not — offline, unconfigured
endpoint, or backend down.

*Defended by:* `P11-09`.
*How it breaks:* a service worker serving a cached shell that renders the lobby as if live.
