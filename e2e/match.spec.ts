import { expect, test } from '@playwright/test';
import { cell, playAt, startMatch } from './support/room';

/**
 * The parts of Phase 9 that only a real browser can answer (P9-04, P9-08).
 *
 * The unit suite already proves the server expires a turn against its own
 * clock. What it cannot prove is what happens to a real tab that stops getting
 * timers: Chromium throttles a backgrounded tab, and a client-side countdown
 * would simply stop. This spec backgrounds a tab for longer than the turn and
 * checks the turn is gone when it comes back.
 */
test.describe('match features in a real browser', () => {
  test('a backgrounded tab loses the turn it did not use', async ({ browser }) => {
    const { host, guest } = await startMatch(browser);

    // The format controls live in a popover now, so that changing them cannot
    // resize the panel and push the board down mid-match (P1-01).
    await host.getByRole('button', { name: /format/i }).click();
    await host.getByRole('button', { name: '15s', exact: true }).click();
    await host.keyboard.press('Escape');
    await expect(host.locator('.turn-clock')).toBeVisible();
    // X moves first, and the host is X in round one.
    await expect(host.locator('.game-status.tone-your-turn')).toBeVisible();

    // A second page in the same context genuinely backgrounds the first in
    // Chromium, which is the condition a client-side timer cannot survive.
    const decoy = await host.context().newPage();
    await decoy.goto('about:blank');
    await decoy.bringToFront();
    await host.waitForTimeout(18_000);
    await decoy.close();
    await host.bringToFront();

    // The server passed the turn while the tab was asleep. No mark was placed:
    // a turn nobody used is a lost turn, not a lost game.
    await expect(guest.locator('.game-status.tone-your-turn')).toBeVisible();
    await expect(host.locator('.game-cell.filled')).toHaveCount(0);
    await expect(host.locator('.notice-toast')).toContainText(/ran out/i);
  });

  test('replays the round from the move history and restores the live board', async ({ browser }) => {
    const { host, guest, pages } = await startMatch(browser);

    // X takes the top row; O answers in the middle.
    for (const index of [0, 3, 1, 4, 2]) await playAt(pages, index);
    await expect(host.locator('.game-board.has-winner')).toBeVisible();

    await host.getByRole('button', { name: /^replay$/i }).click();
    // The replay starts from an empty board, which is the one state that
    // cannot be the live position in a finished round.
    await expect(host.locator('.game-board.is-replaying')).toBeVisible();
    await expect(cell(host, 2)).not.toHaveClass(/filled/);

    // And it ends by handing the real position back, with nothing to unwind.
    await expect(host.locator('.game-board.is-replaying')).toHaveCount(0, { timeout: 20_000 });
    await expect(cell(host, 2)).toHaveClass(/filled/);
    await expect(host.locator('.game-board.has-winner')).toBeVisible();
    // The opponent's board was never touched: a replay is a local view of
    // shared history, not a change to the room.
    await expect(guest.locator('.game-board.is-replaying')).toHaveCount(0);
  });
});
