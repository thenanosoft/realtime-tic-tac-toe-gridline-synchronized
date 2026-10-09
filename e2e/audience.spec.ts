import { expect, test, type Browser, type Page } from '@playwright/test';
import { openRoom, playAt, waitForPlay } from './support/room';

/**
 * One link, four people, and the host deciding who plays (P13-04 … P13-09).
 *
 * This is the flow the feature exists for, so it is tested as the flow: open a
 * room, send one link to everybody, and watch the room sort out who is in which
 * chair. Nothing here types a room code.
 */

async function openInvite(browser: Browser, inviteUrl: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(inviteUrl);
  await expect(page.locator('.connection-connected')).toBeVisible();
  await expect(page.locator('.room-heading h1 b')).toBeVisible();
  return page;
}

test.describe('a room with an audience', () => {
  test('one link seats the first arrival and seats the rest in the audience', async ({ browser }) => {
    const { page: host, roomCode, inviteUrl } = await openRoom(browser);

    // The same URL, four times. The second arrival takes the empty chair; the
    // third and fourth find the room full and are shown it rather than being
    // turned away - which is what the separate watcher link used to be for.
    const guest = await openInvite(browser, inviteUrl);
    await waitForPlay(host);
    await expect(guest.locator('.player-card')).toHaveCount(2);

    const watcherOne = await openInvite(browser, inviteUrl);
    const watcherTwo = await openInvite(browser, inviteUrl);
    await expect(watcherOne.locator('.spectator-banner')).toBeVisible();
    await expect(watcherTwo.locator('.room-heading h1 b')).toHaveText(roomCode);

    // Everybody can see how many people are watching.
    for (const page of [host, guest, watcherOne, watcherTwo]) {
      await expect(page.locator('.audience-count strong')).toHaveText('2');
    }
  });

  test('a watcher asks to play, the host seats them, and the player steps out', async ({ browser }) => {
    const { page: host, inviteUrl } = await openRoom(browser);
    const guest = await openInvite(browser, inviteUrl);
    await waitForPlay(host);
    const watcher = await openInvite(browser, inviteUrl);

    await watcher.getByRole('button', { name: /ask to play/i }).click();
    await expect(watcher.getByRole('button', { name: /waiting for a seat/i })).toBeVisible();
    // The queue is visible to everyone, so the host's choice does not look
    // arbitrary to the people waiting in it.
    await expect(host.locator('.play-queue li')).toHaveCount(1);
    await expect(guest.locator('.play-queue li')).toHaveCount(1);

    // Mid-round the control is there but disabled, with the reason on it.
    await expect(host.locator('.seat-watcher')).toBeDisabled();
    for (const index of [0, 3, 1, 4, 2]) await playAt([host, guest], index);
    await expect(host.locator('.game-board.has-winner')).toBeVisible();
    await expect(host.locator('.seat-watcher')).toBeEnabled();

    await host.locator('.seat-watcher').click();
    // The watcher is now playing, and the player they replaced is watching.
    await expect(watcher.locator('.game-board')).toBeVisible();
    await expect(watcher.locator('.spectator-banner')).toHaveCount(0);
    await expect(guest.locator('.spectator-banner')).toBeVisible();
    await expect(host.locator('.audience-count strong')).toHaveText('1');
    // A different opponent is a different series.
    await expect(host.locator('.series-scores')).toContainText('0');
  });

  test('everyone in the room is named on what they say', async ({ browser }) => {
    const { page: host, inviteUrl } = await openRoom(browser);
    const guest = await openInvite(browser, inviteUrl);
    await waitForPlay(host);
    const watcher = await openInvite(browser, inviteUrl);

    const say = async (page: Page, text: string) => {
      await page.getByRole('button', { name: /chat/i }).first().click();
      await page.locator('.composer-input textarea').fill(text);
      await page.locator('.composer-input textarea').press('Enter');
    };

    await say(guest, 'from the other chair');
    await say(watcher, 'from the cheap seats');

    // The host sees both, each with its sender's name - and the watcher's
    // marked as watching, so four people in one conversation stay apart.
    await expect(host.locator('.chat-message')).toHaveCount(2);
    const names = await host.locator('.chat-message-meta strong').allInnerTexts();
    expect(new Set(names).size).toBe(2);
    await expect(host.locator('.chat-message').last().locator('.sender-role')).toHaveText(/watching/i);

    // And the watcher reads the conversation, which only works because the one
    // link carried them the room key as well (P13-05).
    await expect(watcher.locator('.chat-message')).toHaveCount(2);
    await expect(watcher.locator('.chat-sealed')).toHaveCount(0);
  });
});
