import type { Page } from '@playwright/test';

/**
 * Holds `game.move` frames at the transport so the optimistic window is
 * observable.
 *
 * Against a local server a move is confirmed in about a millisecond, so any
 * test that tries to *catch* the in-flight state by racing it is a flake
 * waiting to happen - the window closes before the first assertion polls. That
 * speed is the feature working; it just makes the state untestable by timing.
 *
 * Delaying the frame makes the window deterministic without faking anything:
 * the real client, the real server and the real protocol, only slower on the
 * wire. `hold` never releases, which is how rollback is tested.
 */
export interface MoveGate {
  /** Delay applied to each outgoing move, in milliseconds. */
  delayMs: number;
  /** When true, moves are dropped entirely and never reach the server. */
  hold: boolean;
}

export async function gateMoves(page: Page, gate: MoveGate): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString();
      if (!text.includes('"game.move"')) {
        server.send(message);
        return;
      }
      if (gate.hold) return;
      if (gate.delayMs <= 0) {
        server.send(message);
        return;
      }
      setTimeout(() => server.send(message), gate.delayMs);
    });
    server.onMessage((message) => ws.send(message));
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));
  });
}
