import { expect, test, type Page } from '@playwright/test';

/**
 * Playing the computer, in a browser (P13-01 … P13-03).
 *
 * The engine itself is proved exhaustively in the unit suite. What only a
 * browser can answer is whether the screen is a game: that it needs no
 * connection, that the computer actually replies, and that the ladder moves.
 */

const cell = (page: Page, index: number) => page.locator(`[data-cell="${index}"]`);

async function openSolo(page: Page) {
  await page.goto('/');
  // Wait for the client to be alive before clicking. goto resolves on load,
  // hydration happens after, and a click in that gap lands on markup that is
  // not listening yet - which looks exactly like a broken button.
  await expect(page.locator('.connection-connected')).toBeVisible();
  await page.getByRole('button', { name: /play the computer/i }).click();
  await expect(page.locator('.solo-shell')).toBeVisible();
}

/** Plays the first open cell and waits for the computer to answer. */
async function takeATurn(page: Page) {
  const before = await page.locator('.game-cell.filled').count();
  for (let index = 0; index < 9; index += 1) {
    const target = cell(page, index);
    if (await target.isEnabled()) {
      await target.click();
      break;
    }
  }
  // Two marks land per turn - yours and the reply - unless the round ended on
  // yours, which the caller checks for.
  await expect
    .poll(async () => page.locator('.game-cell.filled').count(), { timeout: 10_000 })
    .toBeGreaterThan(before);
}

test.describe('solo play', () => {
  test('works with no connection at all', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('.connection-connected')).toBeVisible();

    // Offline before the game even starts: a game with one person in it has
    // nothing to ask a server for, and the offer is visible precisely when
    // there is no connection.
    await context.setOffline(true);
    await expect(page.locator('.offline-banner')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /play the computer/i }).click();
    await expect(page.locator('.solo-shell')).toBeVisible();

    await cell(page, 4).click();
    await expect(cell(page, 4)).toHaveClass(/filled/);
    // The computer answers while the network is still down.
    await expect
      .poll(async () => page.locator('.game-cell.filled').count(), { timeout: 10_000 })
      .toBe(2);
    await context.close();
  });

  test('answers every move until the round ends, and offers the next one', async ({ page }) => {
    await openSolo(page);
    await expect(page.locator('.room-heading h1')).toContainText('Casual');

    for (let turn = 0; turn < 5; turn += 1) {
      if (await page.locator('.rematch-button').isVisible()) break;
      await takeATurn(page);
    }

    // Casual is beatable, but not reliably in five turns by playing the first
    // open cell - so the assertion is that the round *concluded*, not that it
    // was won.
    await expect(page.locator('.rematch-button')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.game-status')).toContainText(/beat|took that one|draw/i);

    await page.getByRole('button', { name: /next round/i }).click();
    // A fresh board, and the record kept the result.
    await expect(page.locator('.game-cell.filled')).toHaveCount(0, { timeout: 10_000 });
    const record = await page.locator('.series-scores').innerText();
    expect(record.replace(/\s+/g, '')).toMatch(/[WL=]1/);
  });

  test('lets the player choose a level, and says what it is', async ({ page }) => {
    await openSolo(page);
    await page.getByRole('button', { name: 'Flawless', exact: true }).click();
    await expect(page.locator('.room-heading h1')).toContainText('Flawless');
    await expect(page.locator('.board-meta')).toContainText(/cannot be beaten/i);
    // Choosing a level starts a fresh round rather than handing a half-played
    // position to a different opponent.
    await expect(page.locator('.game-cell.filled')).toHaveCount(0);
  });

  test('leaves nothing behind when you go back', async ({ page }) => {
    await openSolo(page);
    await cell(page, 0).click();
    await page.getByRole('button', { name: /leave the solo game/i }).click();
    await expect(page.locator('.lobby-layout')).toBeVisible();
    // No room was ever opened, so there is nothing to clean up and nothing in
    // the address bar to leak.
    expect(new URL(page.url()).hash).toBe('');
    const stored = await page.evaluate(() => ({
      session: sessionStorage.length,
      local: Object.keys({ ...localStorage }),
    }));
    expect(stored.session).toBe(0);
    expect(stored.local.filter((key) => !key.includes('muted'))).toEqual([]);
  });
});
