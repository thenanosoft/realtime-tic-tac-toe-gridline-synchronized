import { expect, test, type Page } from '@playwright/test';
import { cell, closeAll, playAt, startMatch } from './support/room';

/**
 * The Phase 1 checks that need a real layout engine (P3-10).
 *
 * `tests/styles.test.ts` can assert what the stylesheet *says*; only a browser
 * can measure what it *does*, after inheritance, media queries and grid sizing
 * have all had their say.
 *
 * These are measured assertions rather than pixel screenshots on purpose:
 * screenshot baselines differ between operating systems and font stacks, so a
 * committed baseline would be a CI flake generator rather than a safety net.
 * Measuring geometry and computed styles catches the defects this phase is
 * about - drifting cells, collapsed boards, unreadable text - without that cost.
 */

const VIEWPORTS = [
  { name: 'mobile portrait', width: 375, height: 667 },
  { name: 'mobile landscape', width: 667, height: 375 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

async function cellBoxes(page: Page) {
  const boxes = [];
  for (let index = 0; index < 9; index += 1) {
    const box = await cell(page, index).boundingBox();
    if (!box) throw new Error('cell ' + index + ' has no box');
    boxes.push(box);
  }
  return boxes;
}

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const verticalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);

test.describe('board geometry (P1-02)', () => {
  test('cells hold identical geometry from an empty board to a finished one', async ({ browser }) => {
    // The original defect: .game-board declared only grid-template-columns, so
    // the three rows were implicit auto tracks. An empty cell has zero content
    // height, and align-content:stretch splits the surplus evenly rather than
    // proportionally - so rows resized with every mark placed and only settled
    // once all nine cells were filled.
    const { host, guest, pages } = await startMatch(browser);

    const empty = await cellBoxes(host);

    for (const [index, box] of empty.entries()) {
      expect(Math.abs(box.width - box.height), 'cell ' + index + ' is not square').toBeLessThanOrEqual(1.5);
      expect(Math.abs(box.width - empty[0].width), 'cell ' + index + ' differs in width').toBeLessThanOrEqual(1.5);
      expect(Math.abs(box.height - empty[0].height), 'cell ' + index + ' differs in height').toBeLessThanOrEqual(1.5);
    }

    // Deliberately a draw sequence, so all nine cells fill and the board is
    // measured in the state the bug used to correct itself in.
    const drawOrder = [4, 0, 8, 2, 6, 3, 5, 7, 1];
    let halfway: Awaited<ReturnType<typeof cellBoxes>> | null = null;

    for (const [played, index] of drawOrder.entries()) {
      await playAt(pages, index);
      await expect(cell(host, index)).toHaveClass(/filled/);
      await expect(cell(guest, index)).toHaveClass(/filled/);
      if (played === 4) halfway = await cellBoxes(host);
      if ((await host.locator('.winning-line').count()) > 0) break;
    }

    expect(halfway, 'the match ended before five marks were placed').not.toBeNull();
    const settled = await cellBoxes(host);

    for (let index = 0; index < 9; index += 1) {
      expect(Math.abs(halfway![index].x - empty[index].x), 'cell ' + index + ' moved horizontally').toBeLessThanOrEqual(1);
      expect(Math.abs(halfway![index].y - empty[index].y), 'cell ' + index + ' moved vertically').toBeLessThanOrEqual(1);
      expect(Math.abs(settled[index].x - empty[index].x), 'cell ' + index + ' drifted by the end').toBeLessThanOrEqual(1);
      expect(Math.abs(settled[index].y - empty[index].y), 'cell ' + index + ' drifted by the end').toBeLessThanOrEqual(1);
    }

    await closeAll(host, guest);
  });

  test('paints gridlines exactly on the cell boundaries', async ({ browser }) => {
    // Gridlines used to be a fixed percentage gradient on the board background,
    // which could not follow the cells. They are now cell borders, so the two
    // cannot disagree - this measures that they line up.
    const { host, guest } = await startMatch(browser);
    const boxes = await cellBoxes(host);

    // Right edge of column 0 meets left edge of column 1, and so on.
    for (const [left, right] of [[0, 1], [1, 2], [3, 4], [4, 5], [6, 7], [7, 8]] as const) {
      const gap = boxes[right].x - (boxes[left].x + boxes[left].width);
      expect(Math.abs(gap), 'columns ' + left + '/' + right + ' do not meet').toBeLessThanOrEqual(1.5);
    }
    for (const [top, bottom] of [[0, 3], [3, 6], [1, 4], [4, 7], [2, 5], [5, 8]] as const) {
      const gap = boxes[bottom].y - (boxes[top].y + boxes[top].height);
      expect(Math.abs(gap), 'rows ' + top + '/' + bottom + ' do not meet').toBeLessThanOrEqual(1.5);
    }

    await closeAll(host, guest);
  });
});

test.describe('responsive coverage (P1-10, P1-11, P1-14)', () => {
  for (const viewport of VIEWPORTS) {
    test(`the lobby fits ${viewport.name} (${viewport.width}x${viewport.height})`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('.lobby-layout')).toBeVisible();

      expect(await horizontalOverflow(page), 'the page scrolls horizontally').toBeLessThanOrEqual(1);
      await expect(page.getByRole('button', { name: /open a private room/i })).toBeVisible();
      await expect(page.getByPlaceholder('ROOM CODE')).toBeVisible();

      // The primary action must be reachable without hunting: comfortably
      // within the first screen and at a real touch size.
      const action = await page.getByRole('button', { name: /open a private room/i }).boundingBox();
      expect(action).not.toBeNull();
      expect(action!.height).toBeGreaterThanOrEqual(44);

      await closeAll(page);
    });
  }

  test('the room stays usable at 375x667 portrait', async ({ browser }) => {
    const { host, guest } = await startMatch(browser, { width: 375, height: 667 });

    expect(await horizontalOverflow(host), 'the room scrolls horizontally').toBeLessThanOrEqual(1);

    const board = await host.locator('.game-board').boundingBox();
    expect(board).not.toBeNull();
    // The board stays the dominant element rather than collapsing to a sliver.
    expect(board!.width).toBeGreaterThan(240);
    expect(board!.width).toBeLessThanOrEqual(375);
    expect(Math.abs(board!.width - board!.height)).toBeLessThanOrEqual(2);

    // Every control a thumb has to hit is at least 44px tall.
    for (const selector of ['.copy-room', '.chat-toggle', '.leave-room']) {
      const box = await host.locator(selector).boundingBox();
      expect(box, selector + ' is missing').not.toBeNull();
      expect(box!.height, selector + ' is below the tap target').toBeGreaterThanOrEqual(44);
    }

    await closeAll(host, guest);
  });

  test('the room stays usable at 667x375 landscape', async ({ browser }) => {
    // Before Phase 1 there was no orientation breakpoint at all, and the board
    // was sized calc(100svh - 470px) - which is negative at this height.
    const { host, guest } = await startMatch(browser, { width: 667, height: 375 });

    const board = await host.locator('.game-board').boundingBox();
    expect(board).not.toBeNull();
    expect(board!.width).toBeGreaterThan(140);
    expect(board!.height).toBeLessThanOrEqual(375);
    expect(Math.abs(board!.width - board!.height)).toBeLessThanOrEqual(2);

    expect(await horizontalOverflow(host), 'the arena scrolls horizontally').toBeLessThanOrEqual(1);
    expect(await verticalOverflow(host), 'the arena is clipped vertically').toBeLessThanOrEqual(8);

    // Both player cards and the status line stay on screen alongside the board.
    await expect(host.locator('.player-card')).toHaveCount(2);
    await expect(host.locator('.game-status')).toBeVisible();

    await closeAll(host, guest);
  });

  test('keeps the board dominant on desktop with 30 chat messages open', async ({ browser }) => {
    const { host, guest } = await startMatch(browser, { width: 1440, height: 900 });
    await expect(host.locator('.chat-panel.is-open')).toBeVisible();

    const before = await host.locator('.game-board').boundingBox();
    const panel = await host.locator('.chat-panel').boundingBox();
    expect(before).not.toBeNull();
    expect(panel).not.toBeNull();

    // Area is the wrong measure of dominance: a tall narrow panel can out-area
    // a square board while occupying a quarter of the screen. Width, height
    // against the viewport, and the panel's share of it are what a reader
    // actually perceives.
    expect(before!.width, 'the board is narrower than the chat panel').toBeGreaterThan(panel!.width);
    expect(before!.height / 900, 'the board is under 40% of the viewport height').toBeGreaterThan(0.4);
    expect(panel!.width / 1440, 'chat takes too much of the screen').toBeLessThan(0.3);

    // The stated requirement: thirty messages must not shrink the arena.
    //
    // Split across both players and paced at 600ms, because the server allows a
    // player only 12 chat messages per 8 seconds and a tighter loop is silently
    // throttled - which is itself a finding, recorded against P7-09: the limit
    // is a flat sliding window that cannot tell an enthusiastic player from a
    // spammer.
    for (let index = 0; index < 30; index += 1) {
      const page = index % 2 === 0 ? host : guest;
      const composer = page.locator('.composer-input textarea');
      await composer.fill('message number ' + (index + 1));
      await composer.press('Enter');
      await page.waitForTimeout(600);
    }
    await expect(host.locator('.chat-message')).toHaveCount(30, { timeout: 30_000 });

    const after = await host.locator('.game-board').boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.width - before!.width), 'the board resized as chat filled').toBeLessThanOrEqual(1);
    expect(Math.abs(after!.x - before!.x), 'the board moved as chat filled').toBeLessThanOrEqual(1);

    await closeAll(host, guest);
  });
});

test.describe('typography floor (P1-04, P1-05)', () => {
  test('renders nothing below the 11px decorative floor', async ({ browser }) => {
    // Before Phase 1 this bottomed out at 5px on mobile. 11px is reserved for
    // uppercase monospace ticker labels; everything else sits at 12px or above.
    const { host, guest } = await startMatch(browser, { width: 375, height: 667 });

    const offenders = await host.evaluate(() => {
      const found: string[] = [];
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const text = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim() ?? '')
          .join('');
        if (!text) continue;
        const style = window.getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        if (element.classList.contains('btn-label') || element.classList.contains('sr-only')) continue;
        const size = Number.parseFloat(style.fontSize);
        if (size > 0 && size < 11) found.push(element.className + ' -> ' + size + 'px: ' + text.slice(0, 30));
      }
      return found;
    });

    expect(offenders, offenders.join('\n')).toEqual([]);
    await closeAll(host, guest);
  });

  test('sets prose and identity text at 12px or above', async ({ browser }) => {
    // The 11px allowance is for ticker labels only. Anything a player actually
    // reads as a sentence, a name or a message must clear the readable floor.
    const { host, guest } = await startMatch(browser, { width: 375, height: 667 });

    const prose = ['.status-copy strong', '.status-copy p', '.player-card h2', '.chat-privacy'];
    for (const selector of prose) {
      const size = await host.locator(selector).first().evaluate(
        (element) => Number.parseFloat(window.getComputedStyle(element).fontSize),
      );
      expect(size, selector + ' renders at ' + size + 'px').toBeGreaterThanOrEqual(12);
    }

    // The composer must be 16px so iOS Safari does not zoom the viewport on
    // focus and throw the player out of the arena mid-match.
    await host.locator('.chat-toggle').click();
    const composer = await host.locator('.composer-input textarea').evaluate(
      (element) => Number.parseFloat(window.getComputedStyle(element).fontSize),
    );
    expect(composer).toBeGreaterThanOrEqual(16);

    await closeAll(host, guest);
  });
});
