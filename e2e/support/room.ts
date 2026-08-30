import { expect, type Browser, type Page } from '@playwright/test';

/**
 * Helpers for driving a real two-player room.
 *
 * Each player gets its own browser *context*, not just its own page:
 * sessionStorage is per-context, so two pages in one context would share the
 * stored session and resume as the same player rather than joining as two.
 */

export async function openRoom(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('.connection-connected')).toBeVisible();
  await page.getByRole('button', { name: /open a private room/i }).click();
  const code = page.locator('.room-heading h1 b');
  await expect(code).toBeVisible();
  const roomCode = (await code.innerText()).trim();
  expect(roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  return { page, roomCode };
}

export async function joinRoom(browser: Browser, roomCode: string, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('.connection-connected')).toBeVisible();
  await page.getByPlaceholder('ROOM CODE').fill(roomCode);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.locator('.room-heading h1 b')).toHaveText(roomCode);
  return page;
}

/** Waits out the server-authoritative countdown between joining and playing. */
export async function waitForPlay(page: Page): Promise<void> {
  await expect(page.locator('.countdown-overlay')).toHaveCount(0, { timeout: 20_000 });
}

export const cell = (page: Page, index: number) => page.locator(`[data-cell="${index}"]`);

/** Plays a cell from whichever page currently owns the turn. */
export async function playAt(pages: Page[], index: number): Promise<void> {
  for (const page of pages) {
    if (await cell(page, index).isEnabled()) {
      await cell(page, index).click();
      return;
    }
  }
  throw new Error('Neither player could play cell ' + index);
}

export async function startMatch(browser: Browser, viewport?: { width: number; height: number }) {
  const { page: host, roomCode } = await openRoom(browser, viewport);
  const guest = await joinRoom(browser, roomCode, viewport);
  await waitForPlay(host);
  await waitForPlay(guest);
  return { host, guest, roomCode, pages: [host, guest] };
}

export async function closeAll(...pages: Page[]): Promise<void> {
  for (const page of pages) await page.context().close();
}
