# Gridline

Gridline is a server-authoritative, two-player Tic-Tac-Toe game. The browser sends commands over a real WebSocket; only the Node server can advance the board, assign marks, start rounds, accept rematches, or restore a session.

## Architecture

### Frontend

- **Vinext + React 19 + TypeScript** for the application shell and component model.
- `useGameSocket` owns connection, heartbeat, exponential-backoff reconnect, session resume, monotonic snapshot handling, and command acknowledgement.
- The browser never applies a move optimistically. A clicked cell is temporarily locked until a newer server snapshot or rejection arrives.
- CSS-driven X/O strokes, winning lines, turn emphasis, countdown, presence transitions, and responsive glass surfaces avoid layout-heavy animation.
- Semantic buttons, arrow-key board navigation, live announcements, visible focus, text-plus-color presence, and `prefers-reduced-motion` cover accessibility.
- Web Audio produces short opt-in interaction sounds; the mute preference is the only sound state stored locally.

### Backend

- A dedicated `ws` server owns all rooms and exposes `/ws` plus `/health`.
- `RoomManager` contains canonical game state, player reservations, request deduplication, countdown timers, rematch votes, session tokens, and cleanup timers.
- Incoming JSON is size-limited, rate-limited, parsed with Zod, and treated as untrusted. Errors are mapped to stable public codes without stack traces.
- Each room command is synchronous and serialized by the Node event loop. A move also carries the snapshot version it was based on; stale/pre-queued commands are rejected and the canonical board is resent.
- Cryptographically random room codes and 256-bit player tokens are generated server-side. The newest socket presenting a valid token replaces an older socket for that same player.

### Shared contract

`shared/protocol.ts` contains the discriminated client message schema, server message union, snapshot model, phases, and rejection codes. `shared/game.ts` is the pure, independently tested game engine.

Client → server:

- `room.create { requestId, name }`
- `room.join { requestId, roomCode, name }`
- `session.resume { requestId, roomCode, playerToken }`
- `game.move { requestId, cell, expectedVersion }`
- `rematch.vote { requestId }`
- `presence.ping { sentAt }`

Server → client:

- `server.hello`
- `session.ready`
- `game.snapshot`
- `command.rejected`
- `server.notice`
- `presence.pong`

## State and recovery

Room phases are explicit: `waiting → countdown → active → game_over/rematch_waiting`, with `paused` used when a live round loses a player. A disconnect never awards a win. The player slot is held, the opponent sees reconnect status, and a valid token can restore identity, mark, turn, board, result, and rematch state. The browser retains only the opaque session credential in `sessionStorage`; it does not cache or restore a board.

Snapshots carry monotonically increasing versions. The client discards an older snapshot, and `expectedVersion` prevents a command composed against stale state from being accepted after another command or presence transition. Duplicate successful request IDs return the current snapshot without applying the command twice.

Completely empty rooms are removed after 60 seconds. A disconnected reservation expires after ten minutes beyond its reconnect grace period. Heartbeats keep legitimately connected rooms active.

## Run locally

Prerequisite: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in two windows. For two devices on the same network, open `http://<computer-lan-ip>:3000`; the browser automatically connects to `ws://<computer-lan-ip>:3001/ws`. Allow those two ports through the host firewall if required.

## Play from another device on your local network

1. Connect both computers or phones to the same Wi-Fi or Ethernet network.
2. On the computer running Gridline, start the app with `npm run dev`.
3. Find that computer's IPv4 address with `ipconfig` on Windows or `ip addr` on Linux.
4. On both devices, open `http://<computer-lan-ip>:3000`. For example, if the host address is `192.168.1.62`, open `http://192.168.1.62:3000`.
5. Create a room on one device, then enter its six-character code on the other device.

The web interface uses TCP port `3000` and the game WebSocket uses TCP port `3001`. If another device cannot connect, allow inbound private-network access to both ports in the host firewall. Do not use `localhost` on the second device: there it refers to the second device itself, not the computer running Gridline.

## Verification commands

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run start
```

`npm run start` runs the built Vinext frontend and the WebSocket authority together. In a public deployment, route the site to port 3000 and `/ws` to port 3001, or set `NEXT_PUBLIC_WS_URL` to the public WebSocket endpoint. Set `ALLOWED_ORIGINS` to the exact public site origin.

## Project structure

```text
app/
  components/       lobby, player cards, board, status, countdown
  hooks/            WebSocket lifecycle and sound
  lib/              device session helpers
server/
  rooms/            authoritative RoomManager
  createGameServer  HTTP upgrade, validation, limits, heartbeat
shared/
  game              pure Tic-Tac-Toe rules
  protocol          typed and validated network contract
tests/
  game.test         pure rule coverage
  multiplayer.test real WebSocket integration flows
```

## Tested failure cases

The automated suite covers valid/occupied/post-completion moves, every victory direction, draw, wrong turn, malformed JSON, invalid cell, third-player rejection, two-client snapshot equality, close-together commands, duplicate request IDs, post-game rejection, two-vote rematch synchronization, disconnect, and token-based reconnect with board restoration.
