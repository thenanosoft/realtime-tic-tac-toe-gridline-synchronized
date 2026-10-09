import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSession, loadSession, saveSession } from '../app/lib/session';

/**
 * The privacy audit, as a test rather than a promise (P12-01 … P12-03).
 *
 * `docs/PRIVACY_AUDIT.md` states what Gridline does not keep. A document makes
 * that claim once; this file makes it on every run. Each rule below is an
 * inventory with an allowlist, so adding a new place that could retain content
 * fails here and has to be argued for in the report rather than slipping in.
 *
 * Comments are stripped before scanning. The code is what runs; a comment
 * explaining why something is *not* used must not read as a use of it.
 */

const ROOTS = ['app', 'server', 'shared', 'scripts'];

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry).split('\\').join('/');
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) found.push(path);
  }
  return found;
}

const FILES = ROOTS.flatMap((root) => sourceFiles(root));

/** Source with comments and string literals of prose removed. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const SOURCES = new Map(FILES.map((path) => [path, code(path)]));

function usedBy(pattern: RegExp): string[] {
  return [...SOURCES.entries()]
    .filter(([, text]) => pattern.test(text))
    .map(([path]) => path)
    .sort();
}

describe('what the product is allowed to retain (P12-01)', () => {
  const rules: Array<{ what: string; pattern: RegExp; allowed: string[]; why: string }> = [
    {
      what: 'localStorage',
      pattern: /\blocalStorage\b/,
      allowed: ['app/hooks/useGameSound.ts'],
      why: 'one boolean: whether the player muted the sound',
    },
    {
      what: 'sessionStorage',
      pattern: /\bsessionStorage\b/,
      allowed: ['app/lib/session.ts'],
      why: 'the session handle - room code, token, player id, name, mark',
    },
    { what: 'IndexedDB', pattern: /\bindexedDB\b|\bopenDatabase\b/, allowed: [], why: 'never used' },
    { what: 'the Cache API', pattern: /\bcaches\b\./, allowed: [], why: 'only the service worker caches, and only the shell' },
    { what: 'cookies', pattern: /document\.cookie|\bsetCookie\b/, allowed: [], why: 'there is no session to carry' },
    {
      what: 'the filesystem',
      pattern: /from 'node:fs'|require\('fs'\)|writeFileSync|createWriteStream|mkdtemp/,
      // Two build-time scripts, neither of which runs while anyone is playing:
      // one writes the committed icons, the other reads the protocol version
      // out of source to check it against the deployed server.
      allowed: ['scripts/generate-icons.mjs', 'scripts/verify-production.mjs'],
      why: 'build scripts only - nothing in the serving path touches a disk',
    },
    { what: 'a database client', pattern: /\b(mysql|pg|postgres|redis|mongodb|mongoose|sqlite|prisma|drizzle)\b/, allowed: [], why: 'rooms live in memory and die with the process (D-003)' },
    { what: 'object storage', pattern: /aws-sdk|@aws-sdk|S3Client|cloudinary|supabase/, allowed: [], why: 'attachments are never written anywhere' },
    { what: 'analytics', pattern: /gtag|googletagmanager|segment\.com|posthog|mixpanel|amplitude|plausible|sentry/i, allowed: [], why: 'nothing is measured about anybody' },
  ];

  for (const rule of rules) {
    it(`uses ${rule.what} in exactly the places the audit lists`, () => {
      expect(usedBy(rule.pattern), rule.what + ': ' + rule.why).toEqual(rule.allowed);
    });
  }

  it('sends nothing to a third party at runtime', () => {
    // No outbound HTTP of any kind from the client or the server. The only
    // network this product opens is its own WebSocket.
    const callers = usedBy(/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon/)
      .filter((path) => !path.startsWith('public/'));
    expect(callers, 'the only connection Gridline opens is its own socket').toEqual([]);
  });
});

describe('the server writes nothing down (P12-02)', () => {
  const serverFiles = FILES.filter((path) => path.startsWith('server/'));

  it('has no filesystem write path at all', () => {
    for (const path of serverFiles) {
      const text = SOURCES.get(path) ?? '';
      expect(text, path + ' touches the filesystem').not.toMatch(/node:fs|writeFile|appendFile|createWriteStream|mkdtemp|os\.tmpdir/);
    }
  });

  it('has no upload directory, because uploads are never files', () => {
    // Phase 7 assembles chunks in memory and hands the result to the room. The
    // usual shape - write the chunks to a temp directory, assemble, unlink - is
    // the one that leaves attachments on a disk after a crash.
    for (const path of serverFiles) {
      expect(SOURCES.get(path) ?? '', path).not.toMatch(/tmpdir|\/tmp\/|uploads?\//i);
    }
  });

  it('logs two lines, neither of which can carry room content', () => {
    const logging = serverFiles.filter((path) => /\bconsole\./.test(SOURCES.get(path) ?? ''));
    // Startup and fatal-start-failure only, both in the entry point. Nothing in
    // the room, protocol or socket paths logs anything at all (INV-8).
    expect(logging).toEqual(['server/index.ts']);
    const entry = SOURCES.get('server/index.ts') ?? '';
    expect(entry.match(/\bconsole\.\w+/g)).toEqual(['console.log', 'console.error']);
    // Nothing from a room can reach either line. `error.message` is allowed,
    // which is why this looks for room vocabulary rather than for the word
    // "message": a start-up failure has to be printable, and it carries no
    // room with it.
    expect(entry).not.toMatch(/\bchat|\btext\b|\bdata\b|snapshot|playerToken|roomCode/i);
  });
});

describe('the two things the browser does keep are content-free (P12-03)', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    // A minimal stand-in, so the real module is exercised rather than a copy of
    // its logic. What is asserted is the bytes it actually writes.
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('stores the session handle and nothing else', () => {
    saveSession({
      roomCode: 'ABC234',
      playerToken: 'a'.repeat(64),
      playerId: '7a1d0f4e-0000-4000-8000-000000000000',
      displayName: 'CosmicOtter',
      mark: 'X',
    });

    const raw = [...store.values()].join('\n');
    expect(JSON.parse(raw)).toEqual({
      roomCode: 'ABC234',
      playerToken: 'a'.repeat(64),
      playerId: '7a1d0f4e-0000-4000-8000-000000000000',
      displayName: 'CosmicOtter',
      mark: 'X',
    });
    // Exhaustive by construction: the stored object is compared whole, so a
    // field added later cannot ride along unnoticed.
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['displayName', 'mark', 'playerId', 'playerToken', 'roomCode']);
  });

  it('never stores a room key', () => {
    // The room secret lives in the URL fragment and in memory. A second copy in
    // storage would survive the tab that earned it (P8-01).
    saveSession({
      roomCode: 'ABC234',
      playerToken: 'token-value-that-is-long-enough',
      playerId: 'id',
      displayName: 'CosmicOtter',
      mark: 'O',
    });
    const raw = [...store.values()].join('\n');
    expect(raw).not.toMatch(/secret|key|iv|epoch/i);
  });

  it('forgets on leaving, and survives corruption without throwing', () => {
    saveSession({ roomCode: 'ABC234', playerToken: 'token-value-long-enough', playerId: 'id', displayName: 'A', mark: 'X' });
    expect(loadSession()).not.toBeNull();
    clearSession();
    expect(store.size).toBe(0);
    expect(loadSession()).toBeNull();

    store.set('gridline.session.v1', '{not json');
    // Corrupt device state is discarded rather than trusted or thrown over.
    expect(loadSession()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('keeps the mute preference as a boolean word', () => {
    const sound = code('app/hooks/useGameSound.ts');
    expect(sound).toMatch(/localStorage\.setItem\(MUTE_KEY, String\(next\)\)/);
    expect(sound).toMatch(/localStorage\.getItem\(MUTE_KEY\) === 'true'/);
    // One key, one value, nothing derived from anything a player said.
    expect(sound.match(/localStorage\.\w+/g)).toEqual(['localStorage.getItem', 'localStorage.setItem']);
  });
});
