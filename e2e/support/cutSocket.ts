import type { Page } from '@playwright/test';

/**
 * A transport that can be cut and restored on demand (P12-06).
 *
 * `context.setOffline` is not enough here, and finding that out was the point:
 * it drops the link without closing an open socket, so the *other* player never
 * learns anything happened. A real interruption is one the server sees - the
 * connection goes away, presence changes, the room pauses - and only closing
 * the socket produces that.
 *
 * Two mechanisms, because each covers what the other cannot:
 *
 *   - An init script wraps `WebSocket` so the live sockets can be closed from
 *     inside the page. That is a genuine close, which both ends observe.
 *   - A route refuses new connections while severed, so the client's reconnect
 *     backoff meets a dead network rather than a working one.
 *
 * **Install it before the page navigates.** Neither hook applies to a socket
 * that already exists, so installing it on a page that is already in a room
 * yields a cutter with nothing to cut - and fails as a silent no-op rather than
 * as an error.
 */
export interface SocketCutter {
  /** Closes the live sockets and refuses new ones until `restore`. */
  cut(): Promise<void>;
  /** Allows connections again. The client's own backoff does the rest. */
  restore(): Promise<void>;
}

declare global {
  interface Window {
    __gridlineSockets?: WebSocket[];
  }
}

export async function cuttableSocket(page: Page): Promise<SocketCutter> {
  const state = { severed: false };

  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const opened: WebSocket[] = [];
    window.__gridlineSockets = opened;
    class Recorded extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        opened.push(this);
      }
    }
    window.WebSocket = Recorded as unknown as typeof WebSocket;
  });

  await page.routeWebSocket(/\/ws/, (ws) => {
    if (state.severed) {
      // Refused outright, which is what a client meets while the network is
      // genuinely gone: not a slow connection, no connection.
      ws.close({ code: 1006, reason: 'network cut' });
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));
  });

  return {
    async cut() {
      state.severed = true;
      await page.evaluate(() => {
        for (const socket of window.__gridlineSockets ?? []) {
          try {
            socket.close(4001, 'network cut');
          } catch {
            // Already closing; nothing to do.
          }
        }
      });
    },
    async restore() {
      state.severed = false;
    },
  };
}
