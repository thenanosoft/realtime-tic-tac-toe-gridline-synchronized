import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Motion, markup and the installable shell (Phase 11).
 *
 * These are source-level assertions, the way the style suite already works.
 * They cannot replace the browser checks - the keyboard walkthrough, the axe
 * scan and the offline run all live in Playwright - but they catch the
 * regressions that are easy to make and invisible in review: the reduced-motion
 * kill switch coming back, a live region losing its politeness, or the manifest
 * and the worker drifting apart.
 */

const css = readFileSync('app/globals.css', 'utf8');
/**
 * The stylesheet with its comments removed.
 *
 * The comments explain what was removed and why, which means they quote the
 * thing being asserted against - so a search over the raw file finds the
 * explanation and reports it as the offence.
 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
const worker = readFileSync('public/sw.js', 'utf8');
const announcer = readFileSync('app/components/Announcer.tsx', 'utf8');

const reducedMotionBlock = (() => {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce) {');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  throw new Error('unterminated reduced-motion block');
})();

describe('reduced motion is designed, not switched off (P11-03, S1-C)', () => {
  it('no longer contains the blanket kill switch', () => {
    // The previous implementation set every duration to .01ms, which stops the
    // movement and makes every state change snap - a countdown that teleports
    // between numbers reads as a broken interface, not a calm one.
    expect(declarations).not.toMatch(/animation-duration:\s*\.01ms/);
    expect(declarations).not.toMatch(/transition-duration:\s*\.01ms/);
  });

  it('keeps opacity and colour transitions so a change still reads as a change', () => {
    expect(reducedMotionBlock).toMatch(/transition-property:\s*opacity[^;]*color/);
    // Shortened, not removed. Zero is the kill switch by another name.
    const duration = /transition-duration:\s*(\d+)ms/.exec(reducedMotionBlock);
    expect(duration).not.toBeNull();
    expect(Number(duration![1])).toBeGreaterThanOrEqual(80);
    expect(Number(duration![1])).toBeLessThanOrEqual(220);
  });

  it('replaces movement with designed crossfades rather than nothing', () => {
    expect(reducedMotionBlock).toContain('animation: none !important');
    for (const designed of ['reduced-fade', 'reduced-emphasis', 'reduced-reaction']) {
      expect(reducedMotionBlock).toContain(designed);
      // Every replacement animation must actually exist, or the rule is a
      // blanket disable wearing a different name.
      expect(css).toContain('@keyframes ' + designed);
    }
  });

  it('keeps the reaction clear of the board in the reduced state too', () => {
    // The glyph stops travelling, so it sits at the path's end point - which is
    // the position the geometry test proves clears the cells (P10-06, INV-16).
    expect(reducedMotionBlock).toMatch(/\.reaction-popup\s*\{[^}]*left:\s*var\(--to-x\)/);
  });

  it('declares no animation durations with an invalid unit', () => {
    // A numeric separator is valid in TypeScript and silently invalid in CSS,
    // which disables the rule it was written for without failing anything.
    expect(declarations).not.toMatch(/\d_\d+(?:ms|s)\b/);
  });
});

describe('announcements are deliberate about urgency (P11-02)', () => {
  it('uses exactly one polite and one assertive region', () => {
    expect(announcer.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(announcer.match(/aria-live="assertive"/g)).toHaveLength(1);
    // Atomic, so a partial change is read as a whole sentence rather than as
    // the one word that happened to differ.
    expect(announcer.match(/aria-atomic="true"/g)).toHaveLength(2);
  });

  it('reserves the assertive region for things that change what you can do', () => {
    const assertive = announcer.slice(announcer.indexOf('const assertive'));
    // Results, the series and losing the network interrupt. Turn changes,
    // moves, presence and incoming messages do not - every assertive
    // announcement cancels the one before it, so a game that shouted
    // everything would be unusable with a screen reader.
    expect(assertive).toContain('assertive.push');
    const politeOnly = ['Your turn.', 'sent a message', 'played'];
    const assertivePushes = [...announcer.matchAll(/assertive\.push\(([\s\S]*?)\);/g)].map((match) => match[1]).join(' ');
    for (const phrase of politeOnly) expect(assertivePushes).not.toContain(phrase);
  });

  it('does not read message bodies aloud', () => {
    // In an encrypted room the text may be unreadable here anyway, and reading
    // every message over a live game is more interruption than it is worth.
    expect(announcer).not.toMatch(/lastMessage\.text/);
  });
});

describe('the installable shell is honest about being offline (P11-08, P11-09)', () => {
  it('declares a manifest a browser will accept', () => {
    expect(manifest.name).toContain('Gridline');
    expect(manifest.display).toBe('standalone');
    // Relative, so the same manifest works at the root in development and under
    // the repository path on GitHub Pages.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) expect(icon.src.startsWith('./')).toBe(true);
  });

  it('serves navigations network-first so a deployed fix reaches installed apps', () => {
    // Cache-first is the usual template and the wrong choice twice over: it
    // pins installed users to a stale build, and it makes an offline app look
    // like a working one.
    const navigation = worker.slice(worker.indexOf("request.mode === 'navigate'"));
    expect(navigation.indexOf('await fetch(request)')).toBeLessThan(navigation.indexOf('caches.match(START)'));
  });

  it('never claims multiplayer works offline', () => {
    expect(worker).toContain('needs a connection');
    // Nothing that could carry room content is cached: no API responses, no
    // messages, no attachments - so there is no cache to leak (INV-8).
    // Only static asset types are cached by extension, and the worker holds no
    // branch for anything else.
    expect(worker).toContain('function isAsset');
    expect(worker).toContain('if (!isAsset(url)) return;');
    // Asserted against the code rather than the file: the comments explain what
    // is deliberately not cached, so they name the very words being looked for.
    const workerCode = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(workerCode).not.toMatch(/\b(chat|attachment|snapshot)\b/i);
  });

  it('cleans up previous versions when it activates', () => {
    expect(worker).toContain('caches.delete');
    expect(worker).toContain('clients.claim');
  });
});

describe('touch and reach on a phone (P11-05, P11-06)', () => {
  it('gives the landscape phone its own rules rather than letting the board overflow', () => {
    expect(css).toContain('@media (orientation: landscape) and (max-height: 460px)');
    const landscape = css.slice(css.indexOf('@media (orientation: landscape) and (max-height: 460px)'));
    expect(landscape).toMatch(/\.game-board\s*\{[^}]*max-height/);
  });

  it('puts the one-thumb controls in the bottom corner, inside the safe area', () => {
    const thumb = css.slice(css.indexOf('@media (max-width: 480px) {'));
    expect(thumb).toMatch(/\.chat-toggle\s*\{[^}]*position:\s*fixed/);
    expect(thumb).toMatch(/bottom:\s*max\(14px,\s*env\(safe-area-inset-bottom\)\)/);
    expect(thumb).toMatch(/min-height:\s*var\(--tap\)/);
  });
});
