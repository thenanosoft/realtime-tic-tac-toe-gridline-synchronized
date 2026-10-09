'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyMove, createInitialGame, GameRuleError, type EngineState, type Mark } from '../../shared/game';
import { chooseMove, nextLevel, type SoloLevel } from '../../shared/solo';

export interface SoloState {
  game: EngineState;
  level: SoloLevel;
  /** Rounds won, drawn and lost against the computer, this session only. */
  record: { won: number; drawn: number; lost: number };
  /** The mark the player holds. They lead the first round and alternate after. */
  playerMark: Mark;
  thinking: boolean;
  /** Set once the round is over, for the status line to read. */
  outcome: 'won' | 'lost' | 'drew' | null;
}

const THINKING_MS = 420;

/**
 * A game against the computer, held entirely here (P13-01).
 *
 * No room, no socket, no server. A solo game has no second person in it, so
 * there is nothing for an authority to arbitrate and nothing for anyone else to
 * see. That also means none of the room machinery has to grow a notion of a
 * player who is not a person.
 *
 * The level and the record live in memory and nowhere else. Persisting them
 * would mean a new browser-storage key, which `tests/privacy.test.ts` would
 * fail - correctly, because this product keeps two things and a running score
 * is not one of them. The ladder resets when you leave, which is the honest
 * version of a game that claims to leave nothing behind.
 */
export function useSoloGame(initialLevel: SoloLevel = 'casual') {
  const [state, setState] = useState<SoloState>(() => ({
    game: createInitialGame(),
    level: initialLevel,
    record: { won: 0, drawn: 0, lost: 0 },
    playerMark: 'X',
    thinking: false,
    outcome: null,
  }));

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every scheduled reply carries the round it belongs to, so a reply computed
  // for a board that has since been reset is discarded instead of landing on
  // the new one.
  const roundRef = useRef(0);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const conclude = useCallback((game: EngineState, playerMark: Mark): SoloState['outcome'] => {
    if (game.isDraw) return 'drew';
    if (!game.winner) return null;
    return game.winner === playerMark ? 'won' : 'lost';
  }, []);

  const scheduleComputerMove = useCallback((game: EngineState, level: SoloLevel, playerMark: Mark, round: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // A visible pause, because an opponent that answers in the same frame reads
    // as the board moving by itself rather than as someone playing.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (roundRef.current !== round) return;
      const computerMark: Mark = playerMark === 'X' ? 'O' : 'X';
      const { cell } = chooseMove(game.board, computerMark, level);
      const next = applyMove(game, computerMark, cell);
      setState((current) => {
        if (roundRef.current !== round) return current;
        const outcome = conclude(next, playerMark);
        return {
          ...current,
          game: next,
          thinking: false,
          outcome,
          record: outcome
            ? {
              won: current.record.won + (outcome === 'won' ? 1 : 0),
              drawn: current.record.drawn + (outcome === 'drew' ? 1 : 0),
              lost: current.record.lost + (outcome === 'lost' ? 1 : 0),
            }
            : current.record,
        };
      });
    }, THINKING_MS);
  }, [conclude]);

  const play = useCallback((cell: number) => {
    setState((current) => {
      if (current.thinking || current.game.winner || current.game.isDraw) return current;
      if (current.game.turn !== current.playerMark) return current;
      let next: EngineState;
      try {
        next = applyMove(current.game, current.playerMark, cell);
      } catch (error) {
        // The board already refuses an occupied cell, so this is a guard
        // against a bug rather than against the player.
        if (error instanceof GameRuleError) return current;
        throw error;
      }

      const outcome = conclude(next, current.playerMark);
      if (!outcome) scheduleComputerMove(next, current.level, current.playerMark, roundRef.current);
      return {
        ...current,
        game: next,
        thinking: !outcome,
        outcome,
        record: outcome
          ? {
            won: current.record.won + (outcome === 'won' ? 1 : 0),
            drawn: current.record.drawn + (outcome === 'drew' ? 1 : 0),
            lost: current.record.lost + (outcome === 'lost' ? 1 : 0),
          }
          : current.record,
      };
    });
  }, [conclude, scheduleComputerMove]);

  const nextRound = useCallback(() => {
    roundRef.current += 1;
    const round = roundRef.current;
    setState((current) => {
      const level = current.outcome ? nextLevel(current.level, current.outcome) : current.level;
      // Marks alternate, like a rematch in a real room, so the player is not
      // always the one leading.
      const playerMark: Mark = current.playerMark === 'X' ? 'O' : 'X';
      const game = createInitialGame();
      const computerLeads = playerMark === 'O';
      if (computerLeads) scheduleComputerMove(game, level, playerMark, round);
      return {
        ...current,
        game,
        level,
        playerMark,
        thinking: computerLeads,
        outcome: null,
      };
    });
  }, [scheduleComputerMove]);

  const setLevel = useCallback((level: SoloLevel) => {
    roundRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    // Changing level starts a fresh round rather than continuing a position
    // half-played by a different opponent.
    setState((current) => ({
      ...current,
      level,
      game: createInitialGame(),
      playerMark: 'X',
      thinking: false,
      outcome: null,
    }));
  }, []);

  return { state, play, nextRound, setLevel };
}
