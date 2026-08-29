import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `rule "${selector}" not found`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const end = css.indexOf('\n}', open);
  return css.slice(open + 1, end);
}

describe('board geometry', () => {
  // Regression guard for the defect where .game-board declared only
  // grid-template-columns. The three rows were then implicit `auto` tracks:
  // an empty cell has zero content height, align-content:stretch distributes
  // the surplus evenly rather than proportionally, and the board visibly
  // rearranged itself with every mark until all nine cells were filled.
  for (const selector of ['.game-board', '.teaser-board']) {
    it(`${selector} sizes both axes explicitly`, () => {
      const body = ruleBody(selector);
      expect(body).toMatch(/grid-template-columns:\s*repeat\(3,\s*1fr\)/);
      expect(body).toMatch(/grid-template-rows:\s*repeat\(3,\s*1fr\)/);
    });

    it(`${selector} does not paint gridlines into its background`, () => {
      // Gridlines painted as fixed background percentages cannot follow the
      // cells, so the two drift apart the moment track sizing changes.
      const body = ruleBody(selector);
      expect(body).not.toMatch(/33\.15%/);
      expect(body).not.toMatch(/66\.58%/);
    });
  }

  it('draws gridlines from the cells themselves', () => {
    expect(css).toMatch(/\.game-cell:not\(:nth-child\(3n\)\)\s*{\s*border-right:/);
    expect(css).toMatch(/\.game-cell:nth-child\(-n\+6\)\s*{\s*border-bottom:/);
    expect(css).toMatch(/\.teaser-cell:not\(:nth-child\(3n\)\)\s*{\s*border-right:/);
    expect(css).toMatch(/\.teaser-cell:nth-child\(-n\+6\)\s*{\s*border-bottom:/);
  });

  it('lets cells shrink inside their tracks', () => {
    expect(ruleBody('.game-cell')).toMatch(/min-height:\s*0/);
  });
});

describe('type scale', () => {
  const TOKEN_FLOOR = 11;
  const READABLE_FLOOR = 12;

  it('defines the scale as tokens', () => {
    for (const token of ['--text-micro', '--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg']) {
      expect(css).toContain(`${token}:`);
    }
  });

  it('reserves the only sub-12px token for decorative labels', () => {
    const micro = /--text-micro:\s*(\d+)px/.exec(css);
    expect(micro).not.toBeNull();
    expect(Number(micro![1])).toBe(TOKEN_FLOOR);
  });

  it('declares no literal font size below the readable floor', () => {
    // Literal pixel font sizes bypass the scale. The previous build had 69 of
    // them between 4px and 11px, bottoming out at 5px on mobile.
    const offenders: string[] = [];
    css.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(/font(?:-size)?:\s*[^;]*?(\d+)px/g)) {
        const size = Number(match[1]);
        if (size < READABLE_FLOOR) offenders.push(`L${index + 1}: ${line.trim().slice(0, 80)}`);
      }
    });
    expect(offenders, `font sizes below ${READABLE_FLOOR}px:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('sizes text inputs at 16px so iOS Safari does not zoom on focus', () => {
    expect(ruleBody('.composer-input textarea')).toMatch(/font-size:\s*var\(--text-md\)/);
    expect(/--text-md:\s*16px/.test(css)).toBe(true);
  });
});

describe('contrast', () => {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const parse = (value: string) => {
    const digits = value.length === 4
      ? value.slice(1).split('').map((c) => c + c).join('')
      : value.slice(1);
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
  };
  const ratio = (a: number[], b: number[]) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  };

  // The raised panel tone rather than the deepest background: it is the lighter
  // of the two grounds, so it yields the lower contrast value for light text.
  const GROUND = parse('#101216');
  const SIGNAL = parse('#d9dfb2');

  it('meets WCAG AA for every foreground colour', () => {
    const offenders: string[] = [];
    const lines = css.split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-fA-F]{3,6})/g)) {
        const foreground = parse(match[1]);
        // Dark ink sits on the signal-coloured buttons, not on the page ground.
        const onSignal = luminance(foreground) < 0.1;
        const value = ratio(foreground, onSignal ? SIGNAL : GROUND);
        if (value < 4.5) offenders.push(`L${index + 1}: ${match[1]} at ${value.toFixed(2)}:1`);
      }
    });
    expect(offenders, `below 4.5:1:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('touch targets', () => {
  it('defines a tap-target token at the 44px guideline', () => {
    expect(css).toMatch(/--tap:\s*44px/);
  });

  it('does not hide labels by zeroing their font size', () => {
    // `font-size: 0` keeps a label only if every such control also carries an
    // aria-label, which is a silent dependency. .btn-label collapses the text
    // while leaving it in the accessibility tree.
    expect(css).not.toMatch(/font-size:\s*0\s*[;}]/);
    expect(css).toContain('.btn-label {');
  });
});

describe('responsive coverage', () => {
  it('has a landscape layout for short viewports', () => {
    // 667x375 previously fell into the stacked tablet layout, where the board
    // was sized `calc(100svh - 470px)` and collapsed to nothing.
    expect(css).toMatch(/@media[^{]*orientation:\s*landscape/);
  });

  it('never sizes the board from a height that can go negative', () => {
    expect(css).not.toMatch(/max-width:\s*min\(610px,\s*calc\(100svh - 470px\)\)/);
    expect(css).toMatch(/max\(280px,\s*calc\(100svh - 470px\)\)/);
  });
});

describe('layout stability', () => {
  it('reserves a fixed height for the status strip', () => {
    // min-height let the strip grow when the detail copy wrapped to a second
    // line or the rematch button appeared, nudging the board mid-match.
    const body = ruleBody('.game-status');
    expect(body).toMatch(/\n\s*height:\s*\d+px/);
    expect(body).not.toMatch(/min-height:/);
  });

  it('reserves two lines for the status detail copy', () => {
    expect(css).toMatch(/\.status-copy p\s*{[^}]*min-height:\s*calc\(2 \* 1\.45 \* var\(--text-2xs\)\)/);
  });
});

describe('mobile controls', () => {
  const mobileBlock = (() => {
    const start = css.indexOf('/* Mobile composition */');
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf('@media (max-width: 390px)'));
  })();

  it('sizes the room controls to the tap target', () => {
    // These were 31px tall, and the destructive leave-room button was 31x31.
    for (const rule of [/\.copy-room\s*{[^}]*height:\s*var\(--tap\)/, /\.chat-toggle,\s*\.leave-room\s*{[^}]*height:\s*var\(--tap\)/, /\.leave-room\s*{\s*width:\s*var\(--tap\)/]) {
      expect(mobileBlock).toMatch(rule);
    }
  });

  it('sizes the composer send button and input to the tap target', () => {
    expect(css).toMatch(/\.chat-send\s*{\s*width:\s*var\(--tap\);\s*height:\s*var\(--tap\)/);
    expect(css).toMatch(/\.composer-tools > button\s*{[^}]*height:\s*var\(--tap\)/);
  });
});

describe('board dominance', () => {
  // The requirement is that the board stays visually dominant on desktop even
  // with a long conversation open. That holds by construction rather than by
  // tuning: the panel is fixed-position at a fixed width and its message list
  // scrolls internally, so message count cannot feed back into board size.
  it('keeps the chat panel out of the document flow', () => {
    expect(ruleBody('.chat-panel')).toMatch(/position:\s*fixed/);
    expect(ruleBody('.chat-panel')).toMatch(/width:\s*min\(/);
  });

  it('scrolls the message list inside the panel', () => {
    expect(ruleBody('.chat-messages')).toMatch(/overflow:\s*auto/);
    expect(ruleBody('.chat-messages')).toMatch(/flex:\s*1 1 auto/);
  });

  it('reserves board width when the panel is open', () => {
    expect(css).toMatch(/\.room-shell\.chat-open \.arena\s*{[^}]*minmax\(405px, 540px\)/);
  });
});
