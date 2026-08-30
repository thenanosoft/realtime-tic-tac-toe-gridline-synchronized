# Gridline

Gridline is a server-authoritative, two-player Tic-Tac-Toe game with temporary player identities and private ephemeral room chat. The browser sends commands over one real WebSocket; only the Node server can assign identities, advance the board, authorize chat, accept rematches, or restore an active session.

## Experience

- Create or join a room without an account or name form. The server assigns a short adjective-animal identity such as `CosmicOtter` and avoids room-level collisions.
- Play the existing synchronized X/O game with countdowns, reconnect pause/resume, winner/draw detection, and two-player rematches.
- Use private text chat, typing indicators, emojis, allowlisted stickers, quick arena reactions, per-message reactions, and image sharing.
- Open chat as a restrained desktop surface or a mobile bottom sheet with unread state, intelligent auto-scroll, touch controls, keyboard focus, Escape handling, and reduced-motion support.

## Architecture

### Frontend

- **Vinext + React 19 + TypeScript** remain the primary app architecture and local/hosted Sites build.
- A separate `next build` static-export target creates `out/` for GitHub Pages with the repository base path applied automatically.
- `useGameSocket` owns connection, heartbeat, exponential-backoff reconnect, token resume, monotonic game snapshots, ephemeral chat state, typing expiry, quick-reaction timers, upload preparation, and Blob URL cleanup.
- The browser never applies a move optimistically. Chat items appear only after the authoritative server broadcasts them.
- Selected JPEG, PNG, or WebP images are decoded, resized to at most 1600 px, compressed to WebP, capped at 1.5 MB, and Base64-encoded inside the authenticated WebSocket JSON protocol. No upload service or permanent URL is created.
- Received image bytes become temporary Blob URLs. Every URL is revoked when history is pruned, the room ends, the session becomes invalid, or the component unmounts.

### Backend

- A dedicated Node `ws` service owns all rooms and exposes `/ws` plus `/health`.
- `RoomManager` contains canonical game state, server-generated identities, player reservations, request deduplication, chat messages, image bytes, reaction sets, typing timers, rematch votes, session tokens, and cleanup timers.
- Incoming JSON is frame-limited, socket-rate-limited, Zod-validated, and then checked again against room membership and feature-specific limits. Client binary frames are rejected rather than accumulated.
- Image payloads are checked for size, metadata consistency, Base64 integrity, and JPEG/PNG/WebP magic bytes. SVG and arbitrary URLs are not accepted.
- Text, media, stickers, reactions, typing, tokens, identities, and game state are all cleared through one `destroyRoom` path.

### Shared protocol

`shared/protocol.ts` contains the discriminated client schema, server union, snapshots, limits, sticker/reaction allowlists, and rejection codes. `shared/game.ts` remains the pure tested game engine.

The wire protocol is at **version 2**. Every client command may carry an optional
`protocolVersion`; its absence is read as version 1 so a client built before
versioning still works. `server.hello` advertises the server's `protocolVersion`
and `minClientProtocol`, and a client outside that range is told to refresh
rather than left to fail silently.

**Ordering.** Nothing on the client is ordered by arrival or by a clock.

- Every authoritative game update carries a strictly increasing `revision`. A
  client never applies a snapshot whose revision is not greater than the one it
  holds, so a delayed packet cannot overwrite newer state.
- Every chat event - message, typing, reaction - carries a `sequence` from one
  monotonic per-room stream. Events that *overwrite* state (typing, reaction
  sets) are discarded when stale; messages, which *append*, are never dropped
  for being late, only inserted at the position their sequence names.
- `RoomSnapshot` is a pure function of the room at a revision, so two clients at
  the same revision hold byte-identical state. Anything time-dependent lives in
  a separate `timing` envelope on the message.

**Clocks.** Deadlines travel as durations (`countdownMsRemaining`,
`reconnect[].msRemaining`), never as absolute epochs. The countdown is rendered
from `performance.now()`, which is monotonic, so a device with a wrong clock
still sees the correct timing.

**Idempotency.** Each player holds a TTL-bounded request ledger. A command
replayed with the same `requestId` is never executed twice; the recorded outcome
is rebuilt from current room state and returned, so a client that retried after a
timeout receives the answer it missed.

Client → server:

- `room.create { requestId }`
- `room.join { requestId, roomCode }`
- `room.leave { requestId }`
- `session.resume { requestId, roomCode, playerToken }`
- `game.move { requestId, cell, expectedRevision }`
- `rematch.vote { requestId }`
- `chat.message`, `chat.typing`, `chat.sticker`, `chat.image`
- `chat.quick-reaction`, `chat.message-reaction`
- `presence.ping`

All of the above additionally accept `protocolVersion`.

Server → client:

- `server.hello` with `protocolVersion` and `minClientProtocol`
- `session.ready` with `playerId`, `playerToken`, `displayName`, game snapshot, `timing`, and active-room RAM chat snapshot
- `game.snapshot` with `snapshot` and `timing`
- `chat.message`, `chat.typing`, `chat.message-reaction`, `chat.quick-reaction`, each carrying `sequence`
- `session.ended`, `command.rejected`, `server.notice`
- `presence.pong`

## Privacy and lifetime

Chat content is held only in process RAM inside the active room. It is not written to a database, Redis, the filesystem, browser local storage, IndexedDB, a service worker, object storage, an upload provider, or analytics.

The browser stores only the opaque room code/player token/temporary identity in `sessionStorage` for refresh recovery. The mute preference remains a device-local `localStorage` setting. Neither location contains chat history or image data.

Room destruction occurs when:

- either participant explicitly ends the private session;
- both participants remain disconnected for the default 90-second active-room grace period;
- an abandoned one-player waiting room remains offline for ten minutes;
- a disconnected reservation remains unclaimed for ten minutes beyond its reconnect deadline; or
- the realtime authority shuts down.

A successful refresh/reconnect before destruction restores the same identity, mark, board, rematch state, and current RAM-only chat snapshot. After destruction, the old token cannot recover anything.

End-to-end encryption is **not implemented**. The server authorizes and temporarily sees chat payloads in RAM. Adding genuine E2EE would require invitation-secret/key-distribution changes that were intentionally not mixed into this stability-focused extension.

## Run locally

Prerequisite: Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000` in two windows. The browser connects to `ws://<current-host>:3001/ws` during local development.

## GitHub Pages

The repository includes `.github/workflows/pages.yml`. Every push to `main` and every manual dispatch:

1. installs from `package-lock.json`;
2. runs tests, type-checking, and lint;
3. builds the static Next export with the project-page base path;
4. uploads `out/` using the official Pages artifact action; and
5. deploys through the `github-pages` environment.

Expected frontend URL:

```text
https://thenanosoft.github.io/realtime-tic-tac-toe-gridline-synchronized/
```

GitHub Pages cannot run the Node WebSocket service. Configure the repository Actions variable `NEXT_PUBLIC_WS_URL` to the real public `wss://.../ws` endpoint before expecting multiplayer on Pages. An insecure `ws://` value fails the workflow. When the variable is absent, the static frontend reports realtime as unavailable instead of attempting localhost or pretending the backend exists.

The realtime backend is defined as a Render Blueprint in `render.yaml`. It runs
as a free Node Web Service in Singapore, uses `/health` for deploy health
checks, accepts public WebSocket upgrades at `/ws`, and automatically deploys
from `main`. Render supplies the public `PORT`; local and self-hosted setups can
continue to use `WS_PORT`.

For any Node WebSocket host, configure:

```text
PORT=<provider port>
ALLOWED_ORIGINS=https://thenanosoft.github.io
```

The origin allowlist uses the origin only, without the GitHub Pages path. Set `NEXT_PUBLIC_WS_URL` to the deployed service's public `wss://` endpoint.

## Verification

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run build:pages
```

The automated suite covers game rules and synchronization, automatic identities and collision handling, reconnect identity/chat recovery, text delivery and deduplication, unauthenticated and oversized chat rejection, typing expiry, quick and message reactions, sticker allowlisting, image MIME/signature/size checks, binary-frame rejection, explicit destruction, stale-token rejection, rematches, disconnects, and empty-room expiry.

It also covers the protocol guarantees: version negotiation across the full skew
matrix, strictly increasing revisions, snapshot equality between two clients at
the same revision, chat sequence monotonicity, exactly-once execution of every
replayed command, and a 10,000-frame fuzz run that the server must survive with
no crash and no accepted garbage.

Style regressions are covered too: board geometry, the 12px type floor, WCAG AA
contrast recomputed on every run, tap-target sizing, and responsive coverage.
