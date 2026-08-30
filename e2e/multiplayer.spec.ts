import { expect, test } from '@playwright/test';
import { cell, closeAll, joinRoom, openRoom, playAt, startMatch, waitForPlay } from './support/room';

/** Two real browser contexts against the real WebSocket authority (P3-09). */
test.describe('two-browser multiplayer', () => {
  test('synchronises a complete match between two independent browsers', async ({ browser }) => {
    const { host, guest, pages } = await startMatch(browser);

    await expect(host.locator('.game-board')).toBeVisible();
    await expect(guest.locator('.game-board')).toBeVisible();

    // X takes the top row, O answers down the middle; 0-1-2 wins.
    for (const index of [0, 3, 1, 4, 2]) {
      await playAt(pages, index);
      // The mark must land on *both* screens. A purely local render would pass
      // a single-page test, which is exactly the bug this guards against.
      await expect(cell(host, index)).toHaveClass(/filled/);
      await expect(cell(guest, index)).toHaveClass(/filled/);
    }

    await expect(host.locator('.winning-line')).toBeVisible();
    await expect(guest.locator('.winning-line')).toBeVisible();

    const hostStatus = await host.locator('.status-copy small').innerText();
    const guestStatus = await guest.locator('.status-copy small').innerText();
    expect(new Set([hostStatus, guestStatus])).toEqual(new Set(['YOU WON', 'OPPONENT WON']));

    for (let index = 0; index < 9; index += 1) {
      expect(await cell(host, index).innerText()).toBe(await cell(guest, index).innerText());
    }

    await closeAll(host, guest);
  });

  test('never lets both players hold an interactive board at once (INV-1)', async ({ browser }) => {
    const { host, guest, pages } = await startMatch(browser);

    const interactivePlayers = async () => {
      let total = 0;
      for (const page of [host, guest]) {
        if ((await page.locator('.game-cell:not([disabled])').count()) > 0) total += 1;
      }
      return total;
    };

    expect(await interactivePlayers()).toBe(1);
    await playAt(pages, 4);
    await expect(cell(host, 4)).toHaveClass(/filled/);
    await expect(cell(guest, 4)).toHaveClass(/filled/);
    expect(await interactivePlayers()).toBe(1);

    await closeAll(host, guest);
  });

  test('recovers the same identity and board after a reload', async ({ browser }) => {
    const { host, guest, roomCode, pages } = await startMatch(browser);

    await playAt(pages, 0);
    await expect(cell(guest, 0)).toHaveClass(/filled/);

    const nameBefore = await host.locator('.player-card:has(.you-tag) h2').innerText();
    await host.reload();

    await expect(host.locator('.room-heading h1 b')).toHaveText(roomCode);
    await expect(cell(host, 0)).toHaveClass(/filled/);
    await expect(host.locator('.player-card:has(.you-tag) h2')).toHaveText(nameBefore);
    // A reload reclaims the existing slot; it must never create a third player.
    await expect(guest.locator('.player-card')).toHaveCount(2);

    await closeAll(host, guest);
  });

  test('tells a joiner plainly when the room code does not exist', async ({ browser }) => {
    const { page } = await openRoom(browser);
    await closeAll(page);

    const context = await browser.newContext();
    const stranger = await context.newPage();
    await stranger.goto('/');
    await expect(stranger.locator('.connection-connected')).toBeVisible();
    await stranger.getByPlaceholder('ROOM CODE').fill('ZZZZZZ');
    await stranger.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(stranger.locator('.notice-toast')).toContainText(/room not found/i);
    await closeAll(stranger);
  });

  test('survives a websocket interruption and resynchronises', async ({ browser }) => {
    // The cut is made at the route level rather than through network emulation.
    // Neither context.setOffline() nor CDP's offline mode tears down an
    // already-established WebSocket in Chromium - both leave the client happily
    // connected, so they prove nothing. Routing the socket gives an honest cut
    // and, as a bonus, counts the reconnect.
    const hostContext = await browser.newContext();
    const host = await hostContext.newPage();

    // An array rather than a mutable `cut` binding: TypeScript narrows a
    // variable that is only ever assigned inside a callback straight back to
    // `null` at the call site. The length doubles as the reconnect counter.
    const sockets: Array<{ cut: () => void }> = [];

    await host.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => ws.send(message));
      ws.onClose((code, reason) => server.close({ code, reason }));
      server.onClose((code, reason) => ws.close({ code, reason }));
      sockets.push({ cut: () => ws.close({ code: 4009, reason: 'network interruption' }) });
    });

    await host.goto('/');
    await expect(host.locator('.connection-connected')).toBeVisible();
    await host.getByRole('button', { name: /open a private room/i }).click();
    await expect(host.locator('.room-heading h1 b')).toBeVisible();
    const roomCode = (await host.locator('.room-heading h1 b').innerText()).trim();

    const guest = await joinRoom(browser, roomCode);
    await waitForPlay(host);
    await waitForPlay(guest);

    await playAt([host, guest], 0);
    await expect(cell(guest, 0)).toHaveClass(/filled/);
    expect(sockets).toHaveLength(1);

    sockets[sockets.length - 1].cut();
    await expect(host.locator('.connection-connected')).toHaveCount(0, { timeout: 20_000 });
    await expect(host.locator('.connection-connected')).toBeVisible({ timeout: 40_000 });
    expect(sockets.length, 'the client never reconnected').toBeGreaterThan(1);

    // The board that survived the cut is still the authoritative one, the room
    // is not wedged, and no third player appeared while the socket was down.
    await expect(cell(host, 0)).toHaveClass(/filled/);
    await expect(host.locator('.room-heading h1 b')).toHaveText(roomCode);
    await expect(host.locator('.player-card')).toHaveCount(2);

    await playAt([host, guest], 3);
    await expect(cell(host, 3)).toHaveClass(/filled/, { timeout: 30_000 });
    await expect(cell(guest, 3)).toHaveClass(/filled/);

    await closeAll(host, guest);
  });
});
