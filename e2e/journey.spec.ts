import { expect, test } from '@playwright/test';
import { cell, joinByInvite, openRoom, playAt, waitForPlay } from './support/room';
import { cuttableSocket } from './support/cutSocket';

/**
 * The whole thing, end to end, in two browsers (P12-05, P12-06).
 *
 * The other specs each prove one property. This one does what a pair of people
 * actually do - open a room, send the link, play, talk, play again, leave - and
 * then does it with the network cut in the middle, because that is the part
 * every other spec is careful to avoid.
 */
test.describe('a complete session', () => {
  test('create, invite, play, talk, rematch, leave', async ({ browser }) => {
    const { page: host, roomCode, inviteUrl } = await openRoom(browser);
    // The invitation carries the room and its key, and nothing else has to be
    // typed anywhere (P8-01, P8-07).
    expect(inviteUrl).toMatch(/#r=[A-HJ-NP-Z2-9]{6}&k=[A-Za-z0-9_-]{43}$/);
    await expect(host.locator('.game-status')).toContainText(/open|share/i);

    const guest = await joinByInvite(browser, inviteUrl);
    await waitForPlay(host);
    await waitForPlay(guest);
    await expect(guest.locator('.room-heading h1 b')).toHaveText(roomCode);
    // Both sides see two players and the same round.
    await expect(host.locator('.player-card')).toHaveCount(2);
    await expect(guest.locator('.player-card')).toHaveCount(2);

    // A conversation both ends can read, which in an encrypted room is only
    // true because the guest arrived by link.
    await host.getByRole('button', { name: /chat/i }).first().click();
    await guest.getByRole('button', { name: /chat/i }).first().click();
    await host.locator('.composer-input textarea').fill('good luck');
    await host.locator('.composer-input textarea').press('Enter');
    await expect(guest.locator('.chat-message').last()).toContainText('good luck');
    await expect(guest.locator('.chat-sealed')).toHaveCount(0);
    await guest.locator('.composer-input textarea').fill('you too');
    await guest.locator('.composer-input textarea').press('Enter');
    await expect(host.locator('.chat-message').last()).toContainText('you too');
    await host.keyboard.press('Escape');
    await guest.keyboard.press('Escape');

    // X takes the top row.
    for (const index of [0, 3, 1, 4, 2]) await playAt([host, guest], index);
    await expect(host.locator('.game-board.has-winner')).toBeVisible();
    await expect(guest.locator('.game-board.has-winner')).toBeVisible();
    // The series score is the server's, and both clients show the same one.
    await expect(host.locator('.series-scores')).toContainText('1');
    await expect(guest.locator('.series-scores')).toContainText('1');

    // A rematch clears the board, swaps the marks and starts a new series,
    // because the single game was already decided.
    await host.getByRole('button', { name: /rematch/i }).click();
    await guest.getByRole('button', { name: /rematch/i }).click();
    await expect(host.locator('.game-cell.filled')).toHaveCount(0);
    await waitForPlay(host);
    await expect(host.locator('.room-kicker')).toContainText('ROUND 02');

    // Leaving is not the end of the room: the other player keeps it.
    host.on('dialog', (dialog) => dialog.accept());
    await host.locator('.leave-room').click();
    await expect(host.locator('.lobby-layout')).toBeVisible();
    await expect(guest.locator('.room-heading h1 b')).toHaveText(roomCode);
  });

  test('survives the network being cut mid-match and comes back to the same board', async ({ browser }) => {
    const { page: host, inviteUrl } = await openRoom(browser);
    // The guest is built by hand rather than through joinByInvite, because the
    // cutter has to exist before the page opens its socket.
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    const network = await cuttableSocket(guest);
    await guest.goto(inviteUrl);
    await expect(guest.locator('.connection-connected')).toBeVisible();
    await expect(guest.locator('.room-heading h1 b')).toBeVisible();
    await waitForPlay(host);
    await waitForPlay(guest);

    await playAt([host, guest], 0);
    await playAt([host, guest], 4);
    await expect(guest.locator('[data-cell="4"]')).toHaveClass(/filled/);

    // Cut the guest off entirely, mid-match. The socket is closed rather than
    // the link merely dropped: setOffline leaves an open socket open, so the
    // server - and therefore the other player - would never learn anything had
    // happened, which is the opposite of what this test is for.
    await network.cut();
    await expect(guest.locator('.connection-connected')).toHaveCount(0, { timeout: 20_000 });
    // The host is told their opponent went quiet rather than being left to
    // wonder, and the board is held exactly as it was.
    await expect(host.locator('.game-status')).toContainText(/quiet|reconnect|paused/i, { timeout: 20_000 });
    await expect(host.locator('[data-cell="4"]')).toHaveClass(/filled/);
    await expect(host.locator('.player-card .presence-reconnecting, .player-card .presence-offline')).toHaveCount(1);

    await network.restore();
    await expect(guest.locator('.connection-connected')).toBeVisible({ timeout: 30_000 });
    // Same room, same board, same identity - the reconnect restores the
    // session rather than starting a new one.
    await expect(guest.locator('[data-cell="0"]')).toHaveClass(/filled/);
    await expect(guest.locator('[data-cell="4"]')).toHaveClass(/filled/);
    await expect(guest.locator('.room-heading h1 b')).toHaveText(await host.locator('.room-heading h1 b').innerText());

    // And the match carries on from where it stopped.
    await waitForPlay(host);
    await playAt([host, guest], 1);
    await expect(cell(guest, 1)).toHaveClass(/filled/);
    await expect(host.locator('.game-cell.filled')).toHaveCount(3);
  });
});
