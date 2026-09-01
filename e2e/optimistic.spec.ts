import { expect, test, type Browser, type Page } from '@playwright/test';
import { cell, closeAll, joinRoom, playAt, waitForPlay } from './support/room';
import { gateMoves, type MoveGate } from './support/slowMoves';

/**
 * Optimistic move rendering in a real browser (Phase 5).
 *
 * The point of the phase is that a move feels instant. The point of these tests
 * is that it is never *wrong* — INV-2 says no client may display a move the
 * server rejected, and optimistic rendering is the only thing that can break it.
 *
 * Every test here holds `game.move` at the transport rather than racing it.
 * Against a local server confirmation lands in about a millisecond, so the
 * in-flight window closes before an assertion can poll for it. Delaying the
 * frame makes that window deterministic while leaving the client, the server
 * and the protocol entirely real.
 */

async function matchWithGatedMoves(browser: Browser, gate: MoveGate): Promise<{ host: Page; guest: Page }> {
  const context = await browser.newContext();
  const host = await context.newPage();
  await gateMoves(host, gate);

  await host.goto('/');
  await expect(host.locator('.connection-connected')).toBeVisible();
  await host.getByRole('button', { name: /open a private room/i }).click();
  await expect(host.locator('.room-heading h1 b')).toBeVisible();
  const roomCode = (await host.locator('.room-heading h1 b').innerText()).trim();

  const guest = await joinRoom(browser, roomCode);
  await waitForPlay(host);
  await waitForPlay(guest);
  return { host, guest };
}

test.describe('optimistic moves', () => {
  test('shows the mark before the server confirms it, then settles', async ({ browser }) => {
    const gate: MoveGate = { delayMs: 1_500, hold: false };
    const { host, guest } = await matchWithGatedMoves(browser, gate);

    const target = cell(host, 4);
    await target.click();

    // Rendered from the local overlay. The frame has not even left the page yet,
    // so the opponent cannot possibly have it — this is the feature itself.
    await expect(target).toHaveClass(/unconfirmed/);
    await expect(target).toHaveClass(/filled/);
    // Announced as in flight, so a screen reader is not told something landed
    // when it has not.
    await expect(target).toHaveAttribute('aria-label', /sending/i);
    await expect(cell(guest, 4)).not.toHaveClass(/filled/);

    // Then the authority speaks and the overlay becomes a real mark.
    await expect(target).not.toHaveClass(/unconfirmed/, { timeout: 15_000 });
    await expect(cell(guest, 4)).toHaveClass(/filled/);
    await expect(target).toHaveAttribute('aria-label', /row 2, column 2: x$/i);

    // Play continues normally once the gate is open.
    gate.delayMs = 0;
    await playAt([host, guest], 0);
    await expect(cell(host, 0)).toHaveClass(/filled/);
    await expect(cell(guest, 0)).toHaveClass(/filled/);

    await closeAll(host, guest);
  });

  test('refuses a second move while one is still in flight (INV-1)', async ({ browser }) => {
    const gate: MoveGate = { delayMs: 2_000, hold: false };
    const { host, guest } = await matchWithGatedMoves(browser, gate);

    await cell(host, 4).click();
    await expect(cell(host, 4)).toHaveClass(/unconfirmed/);

    // Nothing else is clickable while the move is outstanding. Without this a
    // player could place two marks against a board the server has not seen —
    // a way to break INV-1 that has nothing to do with the opponent.
    expect(await host.locator('.game-cell:not([disabled])').count()).toBe(0);

    // And it stays that way for the whole in-flight window, not just an instant.
    await host.waitForTimeout(800);
    expect(await host.locator('.game-cell:not([disabled])').count()).toBe(0);

    await closeAll(host, guest);
  });

  test('rolls the mark back when the move never lands', async ({ browser }) => {
    // Held forever: the server never hears the move. Silence must not read as
    // confirmation.
    const gate: MoveGate = { delayMs: 0, hold: true };
    const { host, guest } = await matchWithGatedMoves(browser, gate);

    await cell(host, 4).click();
    await expect(cell(host, 4)).toHaveClass(/unconfirmed/);
    await expect(cell(host, 4)).toHaveAttribute('aria-label', /sending/i);

    // The client withdraws an unacknowledged move after five seconds.
    await expect(cell(host, 4)).not.toHaveClass(/filled/, { timeout: 15_000 });
    await expect(host.locator('.notice-toast')).toContainText(/did not confirm|restored/i);

    // The opponent never saw anything, because nothing ever reached the server.
    await expect(cell(guest, 4)).not.toHaveClass(/filled/);

    // The board is playable again rather than wedged behind a dead move.
    gate.hold = false;
    await cell(host, 4).click();
    await expect(cell(guest, 4)).toHaveClass(/filled/, { timeout: 15_000 });

    await closeAll(host, guest);
  });

  test('leaves no unbacked mark on either screen once a match plays out', async ({ browser }) => {
    // The end-state form of INV-2: after a full match under a slow link, what
    // each player sees must be exactly what the server has.
    const gate: MoveGate = { delayMs: 400, hold: false };
    const { host, guest } = await matchWithGatedMoves(browser, gate);

    for (const index of [0, 3, 1, 4, 2]) {
      await playAt([host, guest], index);
      await expect(cell(host, index)).toHaveClass(/filled/, { timeout: 15_000 });
      await expect(cell(guest, index)).toHaveClass(/filled/, { timeout: 15_000 });
    }

    await expect(host.locator('.winning-line')).toBeVisible();
    await expect(host.locator('.game-cell.unconfirmed')).toHaveCount(0);
    await expect(guest.locator('.game-cell.unconfirmed')).toHaveCount(0);
    for (let index = 0; index < 9; index += 1) {
      expect(await cell(host, index).innerText()).toBe(await cell(guest, index).innerText());
    }

    await closeAll(host, guest);
  });
});
