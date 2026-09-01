# Invariants

Properties that must hold at every instant, under every network condition. These are not
goals — they are the definition of correctness. Every one has, or will have, a test that
defends it. The chaos suite (`P3-05`) asserts INV-1 … INV-6 continuously during runs.

**Status after Phase 5.** INV-1, INV-2, INV-3, INV-4, INV-5, INV-6 and INV-11 are all
defended by running tests. INV-6 was tightened in Phase 4, and INV-2 became a real property
rather than a tautology in Phase 5 — see both below. The chaos suite asserts INV-1, INV-2, INV-4 and INV-6 after every
delivered event across 200 seeded runs at 800ms ±400ms latency, and INV-3 at the end of each.
INV-7 through INV-10 belong to phases that have not started.

---

### INV-1 — Turn exclusivity
At no point may two clients simultaneously be **able to act**, and no client may act twice
against a board the server has not confirmed.

**Extended in Phase 5.** Optimistic rendering introduced a second way to break this that has
nothing to do with the opponent: a player could place two marks in a row locally. An outstanding
speculation therefore blocks further moves, which is why `canPlay` takes it as an input.

**Refined in Phase 3.** The original wording — "believe it is their turn" — is not enforceable
as written. Mid-propagation, one client may still hold revision 5 (its turn) while the other
already has revision 6 (its turn), and both *read* as "your turn" for one network delay. What
must never happen is that both can *act*, because that is what produces a rejected move and a
board that snaps back. Interactivity is the property the UI gates on and the property the
chaos suite measures.

**A real violation was found and fixed here.** The client marked the connection `connected` the
instant a socket opened, before `session.resume` was answered. The board it still held from
before the drop was stale, but presented as playable — so a reconnecting player and their
opponent both had live boards. Fixed with a `resyncing` flag that keeps the board inert until
the server confirms the resumed session.

*Defended by:* the chaos suite (200 seeded runs), `e2e/multiplayer.spec.ts`, and `P5-05` when
optimistic rendering arrives.
*How it breaks:* any path that presents a held snapshot as current before the server has
confirmed it — a reconnect, a resume, or a future optimistic turn flip.

### INV-2 — No phantom moves
At no point may a client display a move that the authoritative server has rejected.

**This only became a real property in Phase 5.** While the client was strictly pessimistic it
held nothing but server-supplied snapshots, so the invariant was true by construction and the
test for it was measuring nothing. Optimistic rendering is what makes it possible to violate,
and so what makes it worth asserting.

The check therefore moved from the snapshot to the **visible board** — the authoritative board
plus any optimistic overlay. Two things are forbidden: showing a mark where the server has a
different one, and showing a mark the server does not have at a square this client is not
currently waiting on. A mark still in flight is not a violation; a mark left standing after the
answer arrived is.

Exactly one function, `settleSpeculation`, removes an optimistic mark, which is what makes this
invariant reviewable rather than diffuse.

*Defended by:* `P5-03`, `P5-04`, the chaos suite (200 seeded runs), and `e2e/optimistic.spec.ts`.
*How it breaks:* a rollback path that misses a case — an explicit rejection, a newer board
without our mark, losing window control, or the server simply never answering.

### INV-3 — Convergence
After connectivity stabilises, all clients in a room converge to exactly the same
authoritative state within one round trip.

This is why `RoomSnapshot` is a pure function of the room at a revision and why everything
time-dependent was moved into a separate `timing` envelope in Phase 2: a snapshot carrying
decaying durations can never be compared between two clients, so the invariant would have been
untestable by construction.

*Defended by:* 200 seeded chaos runs, each ending with a byte-identical comparison of both
clients against the server; plus the same-revision equality test from Phase 2.
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
A single session never appears as two players, and **at most one connection may act** on a
player slot at any moment.

**Tightened in Phase 4.** Several connections attached to one player is now legal and expected —
a laptop and a phone, or two tabs. What must never happen is two of them being able to act. The
invariant moved from "one connection per player" to "one *controller* per player", which is
strictly stronger: the old wording would have been satisfied by simply refusing the second
connection, which is exactly the behaviour D-002 rejected.

*Defended by:* `P4-03`, `P4-09` (a twelve-window reconnect storm), and `e2e/ownership.spec.ts`.
*How it breaks:* granting control without displacing the previous holder, or a client-side
control toggle that the server does not arbitrate.

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
