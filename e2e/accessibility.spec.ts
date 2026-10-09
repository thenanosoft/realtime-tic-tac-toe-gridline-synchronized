import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { joinRoom, openRoom, startMatch, waitForPlay } from './support/room';

/** Tabs forward until the selector holds focus, failing if it never does. */
async function tabTo(page: Page, selector: string, limit = 20): Promise<void> {
  for (let press = 0; press < limit; press += 1) {
    if (await page.locator(selector).evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  expect(await page.locator(selector).evaluate((node) => node === document.activeElement), selector + ' never received focus').toBe(true);
}

/**
 * The Phase 11 checks that only a browser can answer.
 *
 * The source-level suite guards the rules; these exercise them. A keyboard
 * walkthrough in particular cannot be faked: either the whole journey is
 * reachable without a mouse or it is not.
 */

async function scan(page: Page, context: string) {
  const results = await new AxeBuilder({ page })
    // The two things the automated scan cannot judge, both already covered:
    // contrast is asserted against the tokens in the style suite, and the
    // generated sigils carry their own descriptions, checked in the identity
    // suite.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter((violation) => violation.impact !== 'minor');
  expect(
    serious.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length})`),
    context,
  ).toEqual([]);
}

test.describe('accessibility (P11-01, P11-02, P11-10)', () => {
  test('the lobby and the room pass an automated scan', async ({ browser }) => {
    const { page, roomCode } = await openRoom(browser);
    // Its own context, not browser.newPage(): axe refuses a page from the
    // default context, and a second page sharing a context would share
    // sessionStorage and resume as the same player.
    const lobbyContext = await browser.newContext();
    const lobby = await lobbyContext.newPage();
    await lobby.goto('/');
    await expect(lobby.locator('.connection-connected')).toBeVisible();
    await scan(lobby, 'lobby');
    await lobbyContext.close();

    const guest = await joinRoom(browser, roomCode);
    await waitForPlay(page);
    await scan(page, 'room, as a player');

    // With the conversation open as well: the panel is the densest part of the
    // interface and the easiest place to lose a label.
    await page.getByRole('button', { name: /chat/i }).first().click();
    await expect(page.locator('.chat-panel.is-open')).toBeVisible();
    await scan(page, 'room with the chat panel open');
    await guest.close();
  });

  test('plays a whole match with the keyboard alone', async ({ browser }) => {
    const { host, guest } = await startMatch(browser);

    // The board: arrow keys move between cells, Enter plays one. No pointer
    // events are dispatched anywhere in this test.
    await host.locator('[data-cell="0"]').focus();
    await host.keyboard.press('Enter');
    await expect(host.locator('[data-cell="0"]')).toHaveClass(/filled/);

    // From an empty cell: a played cell is disabled, and a disabled button
    // cannot take focus - which is correct, and is why the walkthrough starts
    // from a square that is still open.
    await guest.locator('[data-cell="1"]').focus();
    await guest.keyboard.press('ArrowDown');
    await guest.keyboard.press('Enter');
    await expect(guest.locator('[data-cell="4"]')).toHaveClass(/filled/);

    // The conversation: open it, type, send, and come back out - the part of
    // the journey a keyboard user usually loses, because focus goes nowhere.
    await host.getByRole('button', { name: /chat/i }).first().focus();
    await host.keyboard.press('Enter');
    await expect(host.locator('.chat-panel.is-open')).toBeVisible();
    // Tab until the composer has focus, which is the honest keyboard question:
    // is it reachable, and in a sane number of stops. The panel also focuses it
    // on open, in which case this costs nothing.
    await tabTo(host, '.composer-input textarea');
    await host.keyboard.type('good luck');
    await host.keyboard.press('Enter');
    await expect(guest.locator('.chat-message').last()).toContainText('good luck');

    // Escape closes the panel and hands focus back to the control that opened
    // it, so the next Tab continues from where the user was.
    await host.keyboard.press('Escape');
    await expect(host.locator('.chat-panel.is-open')).toHaveCount(0);
    await expect(host.locator('.chat-toggle')).toBeFocused();

    // And the board is still playable from the keyboard afterwards.
    await host.locator('[data-cell="1"]').focus();
    await host.keyboard.press('Enter');
    await expect(host.locator('[data-cell="1"]')).toHaveClass(/filled/);
  });

  test('announces the turn politely and the result assertively', async ({ browser }) => {
    const { host, guest, pages } = await startMatch(browser);
    const polite = host.locator('[aria-live="polite"][aria-atomic="true"]').first();
    const assertive = host.locator('[aria-live="assertive"][aria-atomic="true"]').first();

    await expect(polite).toContainText(/your turn|their turn/i);
    await expect(assertive).toHaveText('');

    const { playAt } = await import('./support/room');
    for (const index of [0, 3, 1, 4, 2]) await playAt(pages, index);

    // The result interrupts, because a player who has just lost needs to know
    // before they try to place another mark.
    await expect(assertive).toContainText(/you won the round|you lost the round/i);
    await expect(guest.locator('[aria-live="assertive"]').first()).toContainText(/round/i);
  });
});

test.describe('offline honesty (P11-09)', () => {
  test('says it is offline rather than showing a board it cannot use', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('.connection-connected')).toBeVisible();

    await context.setOffline(true);
    // The claim under test: an app with no network says so, rather than
    // presenting a lobby whose buttons quietly do nothing.
    await expect(page.locator('.offline-banner')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.offline-banner')).toContainText(/needs a connection/i);
    await expect(page.locator('[aria-live="assertive"]').first()).toContainText(/offline/i);

    await context.setOffline(false);
    // And it comes back by itself, without a reload.
    await expect(page.locator('.offline-banner')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.connection-connected')).toBeVisible({ timeout: 30_000 });
    await context.close();
  });
});

test.describe('layout under load (P11-07)', () => {
  test('keeps the board dominant with thirty messages open', async ({ browser }) => {
    const { host, guest } = await startMatch(browser, { width: 1440, height: 900 });
    await host.getByRole('button', { name: /chat/i }).first().click();
    await expect(host.locator('.chat-panel.is-open')).toBeVisible();

    const before = await host.locator('.game-board').boundingBox();
    await guest.getByRole('button', { name: /chat/i }).first().click();
    // Alternating senders, and slowing down past the burst allowance. The
    // server's token bucket forgives a burst of ten and then refills at one a
    // second (P7-09), so thirty messages fired instantly would be *correctly*
    // throttled - the earlier version of this test was measuring the rate
    // limiter rather than the layout.
    const composers = [host, guest].map((page) => page.locator('.composer-input textarea'));
    const say = async (composer: typeof composers[number], text: string) => {
      await composer.fill(text);
      await composer.press('Enter');
    };
    // Ten each inside the burst allowance, then paced past it. The bucket
    // refills at one a second per player, so alternating at 1.1s keeps both
    // senders just inside the limit.
    for (let round = 0; round < 10; round += 1) {
      for (const composer of composers) await say(composer, 'message in a long conversation, burst ' + round);
    }
    for (let index = 0; index < 10; index += 1) {
      await say(composers[index % 2], 'message in a long conversation, paced ' + index);
      await host.waitForTimeout(1_100);
    }
    await expect(host.locator('.chat-message')).toHaveCount(30, { timeout: 30_000 });

    const after = await host.locator('.game-board').boundingBox();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // The board does not shrink as the conversation grows: the panel has its
    // own column, and a chat that squeezed the game would have the priorities
    // backwards.
    expect(after!.width).toBeCloseTo(before!.width, 0);
    // And it still owns a serious share of the viewport.
    expect(after!.width).toBeGreaterThan(360);
    await guest.close();
  });
});
