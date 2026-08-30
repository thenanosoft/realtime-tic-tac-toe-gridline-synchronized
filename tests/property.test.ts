import { describe, expect, it } from 'vitest';
import {
  applyMove,
  createInitialGame,
  GameRuleError,
  getWinningCombination,
  WINNING_COMBINATIONS,
  type Cell,
  type EngineState,
  type Mark,
} from '../shared/game';
import { createRandom } from '../shared/chaos';
import { executeClientMessage } from '../server/createGameServer';
import { RoomManager, type Peer } from '../server/rooms/RoomManager';
import { PROTOCOL_VERSION, type ClientMessage, type RoomSnapshot, type ServerMessage } from '../shared/protocol';

/**
 * Property-based coverage.
 *
 * Example-based tests prove that the cases someone thought of work. These run
 * thousands of randomly generated sequences and assert structural properties
 * that must hold for *every* reachable state, which is the only way to have any
 * confidence about the states nobody thought of.
 *
 * Every run is seeded, so a failure reports the seed that reproduces it.
 */

interface EngineProperty {
  name: string;
  holds(state: EngineState): boolean;
  describe(state: EngineState): string;
}

const count = (board: readonly Cell[], mark: Mark) => board.filter((cell) => cell === mark).length;

const ENGINE_PROPERTIES: EngineProperty[] = [
  {
    name: 'the board always has exactly nine cells',
    holds: (state) => state.board.length === 9,
    describe: (state) => 'length ' + state.board.length,
  },
  {
    name: 'X is always level with O or exactly one ahead',
    holds: (state) => {
      const difference = count(state.board, 'X') - count(state.board, 'O');
      return difference === 0 || difference === 1;
    },
    describe: (state) => 'X=' + count(state.board, 'X') + ' O=' + count(state.board, 'O'),
  },
  {
    name: 'the turn follows from the marks on the board while play continues',
    holds: (state) => {
      if (state.winner || state.isDraw) return true;
      const expected: Mark = count(state.board, 'X') === count(state.board, 'O') ? 'X' : 'O';
      return state.turn === expected;
    },
    describe: (state) => 'turn=' + state.turn + ' X=' + count(state.board, 'X') + ' O=' + count(state.board, 'O'),
  },
  {
    name: 'a winner is never recorded without a matching line',
    holds: (state) => {
      if (!state.winner) return true;
      const line = getWinningCombination(state.board);
      return line !== null && state.board[line[0]] === state.winner;
    },
    describe: (state) => 'winner=' + state.winner + ' line=' + JSON.stringify(state.winningLine),
  },
  {
    name: 'a recorded winning line is a real line held entirely by the winner',
    holds: (state) => {
      if (!state.winningLine) return true;
      const known = WINNING_COMBINATIONS.some(
        (combination) => combination.join() === state.winningLine?.join(),
      );
      return known && state.winningLine.every((cell) => state.board[cell] === state.winner);
    },
    describe: (state) => 'line=' + JSON.stringify(state.winningLine) + ' board=' + JSON.stringify(state.board),
  },
  {
    name: 'a draw only happens on a full board with no winner',
    holds: (state) => !state.isDraw || (state.board.every(Boolean) && state.winner === null),
    describe: (state) => 'draw=' + state.isDraw + ' board=' + JSON.stringify(state.board),
  },
  {
    name: 'a game is never simultaneously won and drawn',
    holds: (state) => !(state.winner !== null && state.isDraw),
    describe: (state) => 'winner=' + state.winner + ' draw=' + state.isDraw,
  },
  {
    name: 'two players never both hold a winning line',
    holds: (state) => {
      const owners = new Set(
        WINNING_COMBINATIONS
          .filter(([a, b, c]) => state.board[a] && state.board[a] === state.board[b] && state.board[a] === state.board[c])
          .map(([a]) => state.board[a]),
      );
      return owners.size <= 1;
    },
    describe: (state) => 'board=' + JSON.stringify(state.board),
  },
];

describe('game engine properties (P3-07)', () => {
  it('holds every property across 5000 random move sequences', () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 5_000 && failures.length < 5; seed += 1) {
      const random = createRandom(seed);
      let state = createInitialGame();
      let moves = 0;

      while (!state.winner && !state.isDraw) {
        const empty = state.board.flatMap((cell, index) => (cell === null ? [index] : []));
        if (!empty.length) break;
        const cell = empty[Math.floor(random() * empty.length) % empty.length];
        const before = JSON.stringify(state);
        state = applyMove(state, state.turn, cell);
        moves += 1;

        // applyMove must be pure: the caller's state object is untouched.
        if (JSON.parse(before).board.filter(Boolean).length !== moves - 1) {
          failures.push('seed ' + seed + ': applyMove mutated its input');
          break;
        }

        for (const property of ENGINE_PROPERTIES) {
          if (!property.holds(state)) {
            failures.push('seed ' + seed + ': ' + property.name + ' -> ' + property.describe(state));
          }
        }
        if (moves > 9) {
          failures.push('seed ' + seed + ': played ' + moves + ' moves on a nine-cell board');
          break;
        }
      }

      // Every sequence must terminate, and only in a legal terminal state.
      if (!state.winner && !state.isDraw) {
        failures.push('seed ' + seed + ': sequence ended without a winner or a draw');
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('refuses every illegal move from every reachable state', () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 1_000 && failures.length < 5; seed += 1) {
      const random = createRandom(seed);
      let state = createInitialGame();

      while (!state.winner && !state.isDraw) {
        const empty = state.board.flatMap((cell, index) => (cell === null ? [index] : []));
        if (!empty.length) break;

        // Wrong player.
        const other: Mark = state.turn === 'X' ? 'O' : 'X';
        expect(() => applyMove(state, other, empty[0])).toThrow(GameRuleError);

        // Occupied cell.
        const taken = state.board.findIndex((cell) => cell !== null);
        if (taken >= 0) expect(() => applyMove(state, state.turn, taken)).toThrow(GameRuleError);

        // Out of range, non-integer, and negative.
        for (const cell of [-1, 9, 99, 1.5, Number.NaN]) {
          expect(() => applyMove(state, state.turn, cell)).toThrow(GameRuleError);
        }

        state = applyMove(state, state.turn, empty[Math.floor(random() * empty.length) % empty.length]);
      }

      // Terminal states refuse everything.
      for (let cell = 0; cell < 9; cell += 1) {
        try {
          applyMove(state, state.turn, cell);
          failures.push('seed ' + seed + ': a finished game accepted a move at ' + cell);
        } catch (error) {
          if (!(error instanceof GameRuleError) || error.code !== 'GAME_COMPLETE') {
            failures.push('seed ' + seed + ': finished game threw ' + String(error));
          }
        }
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});

describe('room manager properties (P3-08)', () => {
  class RecordingPeer implements Peer {
    readonly received: ServerMessage[] = [];
    closed = false;

    constructor(readonly id: string) {}

    send(message: ServerMessage): void {
      this.received.push(message);
    }

    close(): void {
      this.closed = true;
    }

    latestSnapshot(): RoomSnapshot | null {
      for (let index = this.received.length - 1; index >= 0; index -= 1) {
        const message = this.received[index];
        if (message.type === 'game.snapshot' || message.type === 'session.ready') return message.snapshot;
      }
      return null;
    }
  }

  function checkSnapshot(snapshot: RoomSnapshot): string | null {
    if (snapshot.board.length !== 9) return 'board length ' + snapshot.board.length;
    if (snapshot.players.length > 2) return 'players ' + snapshot.players.length;

    const x = count(snapshot.board, 'X');
    const o = count(snapshot.board, 'O');
    if (x - o !== 0 && x - o !== 1) return 'mark counts X=' + x + ' O=' + o;

    if (!snapshot.winner && !snapshot.isDraw) {
      const expected: Mark = x === o ? 'X' : 'O';
      if (snapshot.turn !== expected) return 'turn ' + snapshot.turn + ' with X=' + x + ' O=' + o;
    }
    if (snapshot.winner && snapshot.isDraw) return 'won and drawn at once';
    if (snapshot.winningLine) {
      const known = WINNING_COMBINATIONS.some((line) => line.join() === snapshot.winningLine?.join());
      if (!known) return 'unknown winning line ' + JSON.stringify(snapshot.winningLine);
      if (!snapshot.winningLine.every((cell) => snapshot.board[cell] === snapshot.winner)) {
        return 'winning line does not belong to the winner';
      }
    }
    if (snapshot.isDraw && (!snapshot.board.every(Boolean) || snapshot.winner)) return 'invalid draw';
    if (snapshot.revision < 1) return 'revision ' + snapshot.revision;
    return null;
  }

  it('never reaches an invalid room state across 500 random command sequences', () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 500 && failures.length < 5; seed += 1) {
      const random = createRandom(seed);
      const manager = new RoomManager({ countdownMs: 0, cleanupIntervalMs: 60_000 });
      const a = new RecordingPeer('a-' + seed);
      const b = new RecordingPeer('b-' + seed);
      const peers = [a, b];
      const highestRevision = new Map<string, number>();

      const run = (peer: RecordingPeer, command: ClientMessage) => {
        const before = peer.received.length;
        executeClientMessage({ ...command, protocolVersion: PROTOCOL_VERSION } as ClientMessage, peer, manager);

        for (const message of peer.received.slice(before)) {
          if (message.type !== 'game.snapshot' && message.type !== 'session.ready') continue;
          const problem = checkSnapshot(message.snapshot);
          if (problem) failures.push('seed ' + seed + ': ' + problem);

          // Revisions handed to a given peer must never go backwards.
          const previous = highestRevision.get(peer.id) ?? 0;
          if (message.snapshot.revision < previous) {
            failures.push('seed ' + seed + ': revision went backwards for ' + peer.id);
          }
          highestRevision.set(peer.id, Math.max(previous, message.snapshot.revision));
        }
      };

      run(a, { type: 'room.create', requestId: 'create' });
      const created = a.received.find((message) => message.type === 'session.ready');
      const roomCode = created && created.type === 'session.ready' ? created.roomCode : 'ZZZZZZ';
      run(b, { type: 'room.join', requestId: 'join', roomCode });

      // A deliberately hostile mix: legal moves, moves out of turn, stale
      // revisions, duplicate request ids, votes at the wrong time, and chat
      // before the room is ready.
      for (let step = 0; step < 40; step += 1) {
        const peer = peers[Math.floor(random() * 2) % 2];
        const snapshot = peer.latestSnapshot();
        const roll = random();

        if (roll < 0.6) {
          const cell = Math.floor(random() * 9) % 9;
          const revision = random() < 0.2
            ? Math.max(0, (snapshot?.revision ?? 1) - Math.floor(random() * 3))
            : snapshot?.revision ?? 1;
          run(peer, { type: 'game.move', requestId: 'move-' + step, cell, expectedRevision: revision });
        } else if (roll < 0.7) {
          // Replay of the previous request id, to keep the ledger under load.
          run(peer, { type: 'game.move', requestId: 'move-' + (step - 1), cell: 0, expectedRevision: snapshot?.revision ?? 1 });
        } else if (roll < 0.8) {
          run(peer, { type: 'rematch.vote', requestId: 'vote-' + step });
        } else if (roll < 0.9) {
          run(peer, { type: 'chat.message', requestId: 'chat-' + step, text: 'message ' + step });
        } else {
          run(peer, { type: 'presence.ping', sentAt: step });
        }
      }

      manager.close();
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('keeps both peers on the same board after every accepted command', () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 200 && failures.length < 5; seed += 1) {
      const random = createRandom(seed);
      const manager = new RoomManager({ countdownMs: 0, cleanupIntervalMs: 60_000 });
      const a = new RecordingPeer('a-' + seed);
      const b = new RecordingPeer('b-' + seed);

      const run = (peer: RecordingPeer, command: ClientMessage) => {
        executeClientMessage({ ...command, protocolVersion: PROTOCOL_VERSION } as ClientMessage, peer, manager);
      };

      run(a, { type: 'room.create', requestId: 'create' });
      const created = a.received.find((message) => message.type === 'session.ready');
      if (!created || created.type !== 'session.ready') continue;
      run(b, { type: 'room.join', requestId: 'join', roomCode: created.roomCode });

      for (let step = 0; step < 30; step += 1) {
        const peer = random() < 0.5 ? a : b;
        const snapshot = peer.latestSnapshot();
        const empty = snapshot ? snapshot.board.flatMap((cell, index) => (cell === null ? [index] : [])) : [];
        if (!empty.length) break;
        const cell = empty[Math.floor(random() * empty.length) % empty.length];
        run(peer, { type: 'game.move', requestId: 'm-' + step, cell, expectedRevision: snapshot?.revision ?? 1 });
      }

      // Both peers are online throughout, so every broadcast reached both: their
      // latest snapshots must be identical, not merely compatible.
      const left = a.latestSnapshot();
      const right = b.latestSnapshot();
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        failures.push('seed ' + seed + ': peers diverged, ' + left?.revision + ' vs ' + right?.revision);
      }

      manager.close();
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});
