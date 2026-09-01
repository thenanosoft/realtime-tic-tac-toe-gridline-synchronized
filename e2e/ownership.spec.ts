import { expect, test, type Browser, type Page } from '@playwright/test';
import { cell, closeAll, joinRoom, playAt, waitForPlay } from './support/room';

/**
 * Multi-tab and multi-device ownership in a real browser (P4-03, P4-04, D-002).
 *
 * The session handle lives in sessionStorage, which is per-tab, so two
 * independently opened tabs do *not* share it. The realistic ways to end up with
 * one session in two places are duplicating a tab (which copies sessionStorage)
 * or opening the same session on another device. This seeds the handle into a
 * fresh context, which models the second device exactly and is far easier to
 * control than a duplicated tab.
 */

const SESSION_KEY = 'gridline.session.v1';

async function readSessionHandle(page: Page): Promise<string> {
  const handle = await page.evaluate((key) => window.sessionStorage.getItem(key), SESSION_KEY);
  expect(handle, 'the page stored no session handle').not.toBeNull();
  return handle as string;
}

/** Opens the same session in a second place, as a second device would. */
async function openSecondWindow(browser: Browser, handle: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(
    ([key, value]) => window.sessionStorage.setItem(key, value),
    [SESSION_KEY, handle] as const,
  );
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

test.describe('multi-tab ownership', () => {
  test('moves control to the newest window and explains the demotion', async ({ browser }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await first.goto('/');
    await expect(first.locator('.connection-connected')).toBeVisible();
    await first.getByRole('button', { name: /open a private room/i }).click();
    await expect(first.locator('.room-heading h1 b')).toBeVisible();
    const roomCode = (await first.locator('.room-heading h1 b').innerText()).trim();

    const guest = await joinRoom(browser, roomCode);
    await waitForPlay(first);
    await waitForPlay(guest);

    const handle = await readSessionHandle(first);
    const second = await openSecondWindow(browser, handle);
    await expect(second.locator('.room-heading h1 b')).toHaveText(roomCode);

    // The displaced window is told in words, and keeps a way back. It is not
    // disconnected and its board is not merely greyed out.
    await expect(first.locator('.control-banner')).toBeVisible();
    await expect(first.locator('.control-banner')).toContainText(/another window has control/i);
    await expect(first.getByRole('button', { name: /take control here/i })).toBeVisible();
    await expect(first.locator('.connection-connected')).toBeVisible();
    await expect(second.locator('.control-banner')).toHaveCount(0);

    // Exactly one window can act.
    expect(await first.locator('.game-cell:not([disabled])').count()).toBe(0);

    // And no third player appeared, however many windows are attached.
    await expect(guest.locator('.player-card')).toHaveCount(2);

    await closeAll(first, second, guest);
  });

  test('keeps the read-only window fully live, not frozen', async ({ browser }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await first.goto('/');
    await expect(first.locator('.connection-connected')).toBeVisible();
    await first.getByRole('button', { name: /open a private room/i }).click();
    const roomCode = (await first.locator('.room-heading h1 b').innerText()).trim();
    const guest = await joinRoom(browser, roomCode);
    await waitForPlay(first);
    await waitForPlay(guest);

    const second = await openSecondWindow(browser, await readSessionHandle(first));
    await expect(first.locator('.control-banner')).toBeVisible();

    // A move made from the controlling window must appear on the demoted one
    // too. A read-only view showing a stale board would be worse than none.
    await playAt([second, guest], 4);
    await expect(cell(second, 4)).toHaveClass(/filled/);
    await expect(cell(first, 4)).toHaveClass(/filled/);
    await expect(cell(guest, 4)).toHaveClass(/filled/);

    await closeAll(first, second, guest);
  });

  test('gives control back when the demoted window claims it', async ({ browser }) => {
    const context = await browser.newContext();
    const first = await context.newPage();
    await first.goto('/');
    await expect(first.locator('.connection-connected')).toBeVisible();
    await first.getByRole('button', { name: /open a private room/i }).click();
    const roomCode = (await first.locator('.room-heading h1 b').innerText()).trim();
    const guest = await joinRoom(browser, roomCode);
    await waitForPlay(first);
    await waitForPlay(guest);

    const second = await openSecondWindow(browser, await readSessionHandle(first));
    await expect(first.locator('.control-banner')).toBeVisible();

    await first.getByRole('button', { name: /take control here/i }).click();

    // The claim is server-authoritative, so both windows learn the outcome.
    await expect(first.locator('.control-banner')).toHaveCount(0);
    await expect(second.locator('.control-banner')).toBeVisible();

    // The window that reclaimed the slot can actually play again.
    await playAt([first, guest], 0);
    await expect(cell(guest, 0)).toHaveClass(/filled/);

    await closeAll(first, second, guest);
  });
});

test.describe('host migration (P4-07)', () => {
  test('leaves the room alive for the remaining player', async ({ browser }) => {
    // This used to end the session for both: a room died with whoever opened it.
    const context = await browser.newContext();
    const host = await context.newPage();
    await host.goto('/');
    await expect(host.locator('.connection-connected')).toBeVisible();
    await host.getByRole('button', { name: /open a private room/i }).click();
    const roomCode = (await host.locator('.room-heading h1 b').innerText()).trim();
    const guest = await joinRoom(browser, roomCode);
    await waitForPlay(host);
    await waitForPlay(guest);

    host.once('dialog', (dialog) => dialog.accept());
    await host.getByRole('button', { name: /leave this room/i }).click();

    // The host is out, and the guest still holds a live room on the same code.
    await expect(host.locator('.lobby-layout')).toBeVisible();
    await expect(guest.locator('.room-heading h1 b')).toHaveText(roomCode);
    await expect(guest.locator('.player-card')).toHaveCount(2);
    await expect(guest.locator('.game-board')).toBeVisible();

    // And it is joinable again by someone new.
    const newcomer = await joinRoom(browser, roomCode);
    await waitForPlay(guest);
    await waitForPlay(newcomer);
    await playAt([guest, newcomer], 4);
    await expect(cell(guest, 4)).toHaveClass(/filled/);
    await expect(cell(newcomer, 4)).toHaveClass(/filled/);

    await closeAll(host, guest, newcomer);
  });
});
