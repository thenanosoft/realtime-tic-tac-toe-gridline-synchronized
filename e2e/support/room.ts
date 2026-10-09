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
  // The address bar is the invitation: the client writes the room code and the
  // room key into the fragment once the room exists (P8-01, P8-07).
  const inviteUrl = page.url();
  expect(inviteUrl).toContain('#r=' + roomCode);
  return { page, roomCode, inviteUrl };
}

/**
 * Joins the way an invitee actually does - by opening the link.
 *
 * Joining by code is also real, and the other specs exercise it, but a code
 * carries no key: in an encrypted room a code-joined guest can play and cannot
 * read the conversation. Any spec that touches chat has to arrive by link.
 */
export async function joinByInvite(
  browser: Browser,
  inviteUrl: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await page.goto(inviteUrl);
  await expect(page.locator('.connection-connected')).toBeVisible();
  // No code to type: the fragment is acted on as soon as the socket opens.
  await expect(page.locator('.room-heading h1 b')).toBeVisible();
  await expect(page.locator('.key-banner')).toHaveCount(0);
  return page;
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
  const { page: host, roomCode, inviteUrl } = await openRoom(browser, viewport);
  // By link, so the guest holds the room key and the pair can actually talk.
  // Joining by code is covered by the specs that are about joining.
  const guest = await joinByInvite(browser, inviteUrl, viewport);
  await waitForPlay(host);
  await waitForPlay(guest);
  return { host, guest, roomCode, inviteUrl, pages: [host, guest] };
}

export async function closeAll(...pages: Page[]): Promise<void> {
  for (const page of pages) await page.context().close();
}
