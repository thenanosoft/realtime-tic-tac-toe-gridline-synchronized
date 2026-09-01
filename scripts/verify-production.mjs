import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

// The constant is read out of the shared source rather than imported. An import
// would pull in zod and depend on Node's type stripping, which is only on by
// default from 22.18 - and package.json allows 22.13. This keeps a single
// source of truth without quietly raising the version floor.
const PROTOCOL_VERSION = Number(
  /export const PROTOCOL_VERSION = ([0-9]+)/.exec(
    readFileSync(new URL('../shared/protocol.ts', import.meta.url), 'utf8'),
  )?.[1],
);
if (!Number.isInteger(PROTOCOL_VERSION)) {
  throw new Error('Could not read PROTOCOL_VERSION from shared/protocol.ts');
}

/**
 * Production smoke test: plays a real match against the deployed backend.
 *
 * The unit and chaos suites prove the code is correct; this proves the thing
 * that is actually running is the code we think it is. It exists because the
 * Pages and Render deploys cannot be sequenced (D-008), so after any protocol
 * change the only reliable signal that the backend has caught up is asking it.
 *
 *   npm run verify:production
 *   WS_URL=wss://staging.example/ws npm run verify:production
 */
const ENDPOINT = process.env.WS_URL ?? 'wss://gridline-realtime.onrender.com/ws';
const ORIGIN = process.env.WS_ORIGIN ?? 'https://thenanosoft.github.io';

class Client {
  constructor(name) { this.name = name; this.messages = []; this.listeners = new Set(); }

  static async connect(name) {
    const client = new Client(name);
    client.socket = new WebSocket(ENDPOINT, { headers: { Origin: ORIGIN } });
    client.socket.on('message', (raw) => {
      client.messages.push(JSON.parse(raw.toString()));
      for (const listener of client.listeners) listener();
    });
    await new Promise((resolve, reject) => {
      client.socket.once('open', resolve);
      client.socket.once('error', reject);
    });
    return client;
  }

  send(message) { this.socket.send(JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION })); }

  waitFor(predicate, timeout = 15_000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(this.name + ' timed out')); }, timeout);
      const check = () => {
        const found = this.messages.find(predicate);
        if (!found) return;
        clearTimeout(timer); this.listeners.delete(check); resolve(found);
      };
      this.listeners.add(check);
    });
  }

  /**
   * Waits until the client's *current* state satisfies the predicate.
   *
   * Distinct from waitFor, which scans the whole message history and so happily
   * matches a state that has since been superseded - asking "is it my turn?"
   * that way always matches the snapshot from before your own last move. This
   * one only ever looks at the latest snapshot.
   */
  waitUntil(predicate, label, timeout = 15_000) {
    if (this.snapshot() && predicate(this.snapshot())) return Promise.resolve(this.snapshot());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(this.name + ' timed out waiting for ' + label));
      }, timeout);
      const check = () => {
        const current = this.snapshot();
        if (!current || !predicate(current)) return;
        clearTimeout(timer); this.listeners.delete(check); resolve(current);
      };
      this.listeners.add(check);
    });
  }

  snapshot() {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m.type === 'game.snapshot' || m.type === 'session.ready') return m.snapshot;
    }
    return null;
  }
  close() { this.socket.close(); }
}

const check = (label, condition, detail = '') => {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  [' + detail + ']' : ''));
  if (!condition) process.exitCode = 1;
};

const x = await Client.connect('X');
const o = await Client.connect('O');

const hello = await x.waitFor((m) => m.type === 'server.hello');
// Compared against the constant, not a literal: this script exists to tell us
// whether the deployed server matches this source tree, so hardcoding a version
// here would make it answer a question about the past.
check('server speaks this protocol version', hello.protocolVersion === PROTOCOL_VERSION, 'got ' + hello.protocolVersion + ', source says ' + PROTOCOL_VERSION);
check('server still serves one version back', hello.minClientProtocol <= PROTOCOL_VERSION - 1, 'minClientProtocol ' + hello.minClientProtocol);

x.send({ type: 'room.create', requestId: 'smoke-create' });
const xs = await x.waitFor((m) => m.type === 'session.ready');
x.mark = xs.mark;
check('room created', /^[A-HJ-NP-Z2-9]{6}$/.test(xs.roomCode), xs.roomCode);
check('snapshot uses revision, not version', typeof xs.snapshot.revision === 'number' && xs.snapshot.version === undefined);
check('timing envelope is separate from the snapshot', typeof xs.timing?.serverTime === 'number');
check('no absolute deadline in the snapshot', xs.snapshot.countdownEndsAt === undefined && xs.snapshot.updatedAt === undefined);
check('chat snapshot carries a sequence', xs.chat.sequence === 0);

o.send({ type: 'room.join', requestId: 'smoke-join', roomCode: xs.roomCode });
const os = await o.waitFor((m) => m.type === 'session.ready');
o.mark = os.mark;
check('second player joined', os.mark === 'O' && xs.mark === 'X');
check('the opener is host', xs.snapshot.players.filter((p) => p.isHost).length === 1);
check('presence is a state, not a boolean', xs.snapshot.players.every((p) => p.presence === 'online'));
check('this window holds the slot', xs.hasControl === true && os.hasControl === true);
check('identities differ', os.displayName !== xs.displayName, xs.displayName + ' vs ' + os.displayName);

await x.waitUntil((s) => s.phase === 'active', 'the match to start');
await o.waitUntil((s) => s.phase === 'active', 'the match to start');
console.log('  ....  match active');

for (const [cell, actor, observer] of [[0, x, o], [3, o, x], [1, x, o], [4, o, x], [2, x, o]]) {
  // Wait for the turn to actually be ours before reading the revision, or the
  // move carries a stale expectedRevision and is rejected as STALE_STATE.
  await actor.waitUntil((s) => s.phase === 'active' && s.turn === actor.mark, 'its turn');
  actor.send({ type: 'game.move', requestId: 'smoke-' + cell, cell, expectedRevision: actor.snapshot().revision });
  // Both sides, not just the observer: waiting on one leaves the other a
  // revision behind and every later assertion reads a stale board.
  await Promise.all([
    actor.waitUntil((s) => s.board[cell] !== null, 'its own move at ' + cell),
    observer.waitUntil((s) => s.board[cell] !== null, 'the move at ' + cell),
  ]);
}

await Promise.all([
  x.waitUntil((s) => s.winner !== null || s.isDraw, 'the result'),
  o.waitUntil((s) => s.winner !== null || s.isDraw, 'the result'),
]);
check('X won on the top row', x.snapshot().winner === 'X', JSON.stringify(x.snapshot().winningLine));
check('both clients converged', JSON.stringify(x.snapshot()) === JSON.stringify(o.snapshot()));

// Idempotency against the live server.
const before = x.snapshot().revision;
x.send({ type: 'game.move', requestId: 'smoke-0', cell: 0, expectedRevision: before });
await new Promise((r) => setTimeout(r, 2_000));
check('replayed move changed nothing', x.snapshot().revision === before && x.snapshot().board.filter(Boolean).length === 5);

// Protocol mismatch is refused, and the socket survives it.
x.socket.send(JSON.stringify({ type: 'room.create', requestId: 'smoke-future', protocolVersion: 99 }));
const rejection = await x.waitFor((m) => m.type === 'command.rejected' && m.requestId === 'smoke-future');
check('future protocol rejected with PROTOCOL_MISMATCH', rejection.code === 'PROTOCOL_MISMATCH', rejection.code);

// Leaving frees a slot rather than ending the room. The survivor keeps a live
// room on the same code, and the host capability moves to them.
x.send({ type: 'room.leave', requestId: 'smoke-leave' });
await x.waitFor((m) => m.type === 'session.ended');
await o.waitUntil((s) => s.players.length === 1, 'the room to survive the departure');
check('the room outlived the player who opened it', o.snapshot().players.length === 1);
check('host migrated to the survivor', o.snapshot().players[0].isHost === true);
check('the board reset for a new opponent', o.snapshot().phase === 'waiting' && o.snapshot().board.every((c) => c === null));

x.close(); o.close();
console.log(process.exitCode ? '\nPRODUCTION SMOKE TEST FAILED' : '\nPRODUCTION SMOKE TEST PASSED');
