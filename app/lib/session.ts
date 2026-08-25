import type { Mark } from '../../shared/game';

const SESSION_KEY = 'gridline.session.v1';
const NAME_KEY = 'gridline.player-name';

export interface StoredSession {
  roomCode: string;
  playerToken: string;
  playerId: string;
  mark: Mark;
}

export function loadSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as Partial<StoredSession> | null;
    if (
      parsed &&
      typeof parsed.roomCode === 'string' &&
      typeof parsed.playerToken === 'string' &&
      typeof parsed.playerId === 'string' &&
      (parsed.mark === 'X' || parsed.mark === 'O')
    ) {
      return parsed as StoredSession;
    }
  } catch {
    // Corrupt device state is discarded; the server still validates every token.
  }
  sessionStorage.removeItem(SESSION_KEY);
  return null;
}

export function saveSession(session: StoredSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export function loadPlayerName(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(NAME_KEY)?.slice(0, 24) ?? '';
}

export function savePlayerName(name: string): void {
  localStorage.setItem(NAME_KEY, name.slice(0, 24));
}
