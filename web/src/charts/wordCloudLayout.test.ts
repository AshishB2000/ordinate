// The word cloud's layout — ./wordCloudLayout.ts. Determinism (same input →
// identical positions, run after run; different boxes → each deterministic), no
// overlaps, inside the box, the size scale, the placement order, and dropping
// rather than overlapping. No canvas: the text measure is a fixed width per
// character, as a monospace font would give.
//
// Ported from scripts/test-wordCloud.ts at the T8.1 cutover, where the same
// checks pinned the desktop's wordCloudLayout.js; ./legacy.test.ts holds this
// port to that file's recorded layout. The drift guard now reads the server's
// own categoryKey (src/analysis/categoryKey.ts), the module the cap comes from.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as portWc from './wordCloudLayout';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const categoryKey = require(path.join(ROOT, 'src/analysis/categoryKey.js')) as { CATEGORY_CAP: number; OTHER_LABEL: string };

describe("word cloud layout", () => {
  it('every check holds', () => {
    const fails: string[] = [];
    const ok = (label: string, cond: boolean, extra?: unknown): void => {
      if (!cond) fails.push(label + (extra === undefined ? '' : '  ' + String(extra)));
    };
    const failureCount = (): number => fails.length;
    // any: the checks index loosely into layouts, as they did against the desktop file
    const wc = portWc as unknown as {
      wordCloudLayout: (words: Array<{ text: string; weight: number }>, opts: any) => any;
      wordCloudHit: (layout: any, x: number, y: number) => any;
      wordCloudIsBucket: (labels: any[], i: number) => boolean;
      WC_CATEGORY_CAP: number;
      WC_OTHER_LABEL: string;
    };

    const measure = (text: string, size: number): number => text.length * size * 0.6;

    // Deterministic "random" words: a fixed LCG, so the fixture itself never changes.
    function fixture(n: number): Array<{ text: string; weight: number }> {
      let s = 12345;
      const next = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
      const syll = ['ka', 'lo', 'mi', 're', 'su', 'to', 'va', 'ne', 'pi', 'do'];
      const out: Array<{ text: string; weight: number }> = [];
      for (let i = 0; i < n; i += 1) {
        const len = 1 + Math.floor(next() * 3);
        let t = '';
        for (let k = 0; k < len; k += 1) t += syll[Math.floor(next() * syll.length)];
        // Zipf-shaped, as term counts are: a few big words, a long tail of small ones.
        out.push({ text: t + i, weight: Math.max(1, Math.round(600 / (1 + i * (0.5 + next())))) });
      }
      return out;
    }

    function overlaps(placed: any[]): Array<[string, string]> {
      const bad: Array<[string, string]> = [];
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const a = placed[i];
          const b = placed[j];
          if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad.push([a.text, b.text]);
        }
      }
      return bad;
    }

    const words = fixture(120);
    const opts = { width: 640, height: 360, minSize: 10, maxSize: 56, measure };
    const a = wc.wordCloudLayout(words, opts);
    const b = wc.wordCloudLayout(words.map((w) => ({ ...w })), { ...opts });
    ok('determinism: the same input gives identical positions, sizes and drops',
      JSON.stringify(a) === JSON.stringify(b), `${a.placed.length} placed`);
    ok('…whatever order the words arrive in', JSON.stringify(wc.wordCloudLayout(words.slice().reverse(), opts).placed
      .map((p: any) => [p.text, p.x, p.y, p.size])) === JSON.stringify(a.placed.map((p: any) => [p.text, p.x, p.y, p.size])));
    ok('no two placed words overlap', overlaps(a.placed).length === 0, JSON.stringify(overlaps(a.placed).slice(0, 3)));
    ok('every word is inside the box', a.placed.every((p: any) => p.x >= 0 && p.y >= 0 && p.x + p.w <= 640 && p.y + p.h <= 360));
    ok('positions are whole pixels', a.placed.every((p: any) => Number.isInteger(p.x) && Number.isInteger(p.y)));
    ok('most of the words fit a 640×360 box', a.placed.length >= 90, `${a.placed.length} of 120`);
    ok('placed + dropped = every word', a.placed.length + a.dropped.length === 120);

    // Placement order and the size scale.
    const sorted = words.slice().sort((p, q) => q.weight - p.weight || (p.text < q.text ? -1 : 1));
    ok('the heaviest word is placed first, at the centre', a.placed[0].text === sorted[0].text
      && Math.abs(a.placed[0].x + a.placed[0].w / 2 - 320) <= 1 && Math.abs(a.placed[0].y + a.placed[0].h / 2 - 180) <= 1,
      JSON.stringify(a.placed[0]));
    ok('the heaviest word gets maxSize, the lightest minSize', a.placed[0].size === 56
      && a.placed.concat([]).sort((p: any, q: any) => p.weight - q.weight)[0].size >= 10);
    const s = wc.wordCloudLayout([{ text: 'a', weight: 1 }, { text: 'b', weight: 4 }, { text: 'c', weight: 9 }], { width: 400, height: 300, minSize: 10, maxSize: 30, measure });
    const sizeOf = (t: string) => s.placed.find((p: any) => p.text === t).size;
    ok('size is a SQUARE-ROOT scale of the weight (1, 4, 9 → 10, 20, 30)', sizeOf('a') === 10 && sizeOf('b') === 20 && sizeOf('c') === 30,
      JSON.stringify(s.placed.map((p: any) => [p.text, p.size])));
    const tie = wc.wordCloudLayout([{ text: 'zeta', weight: 5 }, { text: 'alpha', weight: 5 }], { width: 400, height: 300, measure });
    ok('ties are broken by the word itself', tie.placed[0].text === 'alpha');
    const eq = wc.wordCloudLayout([{ text: 'x', weight: 3 }, { text: 'y', weight: 3 }], { width: 400, height: 300, minSize: 10, maxSize: 30, measure });
    ok('all-equal weights take the middle size', eq.placed.every((p: any) => p.size === 20));

    // Different boxes: each deterministic, each overlap-free and inside.
    for (const [w, h] of [[300, 180], [1100, 620], [240, 400]]) {
      const o = { width: w, height: h, minSize: 8, maxSize: 40, measure };
      const x1 = wc.wordCloudLayout(words, o);
      const x2 = wc.wordCloudLayout(words, o);
      ok(`${w}×${h}: deterministic, no overlaps, inside`, JSON.stringify(x1) === JSON.stringify(x2) && overlaps(x1.placed).length === 0
        && x1.placed.every((p: any) => p.x >= 0 && p.y >= 0 && p.x + p.w <= w && p.y + p.h <= h), `${x1.placed.length} placed`);
    }
    const small = wc.wordCloudLayout(words, { width: 300, height: 180, minSize: 8, maxSize: 40, measure });
    ok('a smaller box DROPS words (named) rather than overlapping them', small.dropped.length > 0 && overlaps(small.placed).length === 0,
      `${small.dropped.length} dropped`);

    // Input hygiene and the hit test.
    const junk = wc.wordCloudLayout([{ text: '', weight: 5 }, { text: 'neg', weight: -1 }, { text: 'nan', weight: NaN }, { text: 'ok', weight: 2 }],
      { width: 200, height: 100, measure });
    ok('empty words and non-positive or non-finite weights are not drawn', junk.placed.length === 1 && junk.placed[0].text === 'ok');
    ok('nothing to draw → an empty layout, not an error', wc.wordCloudLayout([], { width: 100, height: 100, measure }).placed.length === 0);
    const huge = wc.wordCloudLayout([{ text: 'x'.repeat(40), weight: 10 }], { width: 200, height: 100, minSize: 6, maxSize: 60, measure });
    ok('a word wider than the box shrinks to fit rather than vanish', huge.placed.length === 1 && huge.placed[0].w <= 200, JSON.stringify(huge.placed[0]));
    const p0 = a.placed[0];
    ok('hit test: the centre of a word finds it; outside finds nothing',
      wc.wordCloudHit(a, p0.x + p0.w / 2, p0.y + p0.h / 2).text === p0.text && wc.wordCloudHit(a, -5, -5) === null);
    ok('placed words keep the index of the category they stand for', a.placed.every((p: any) => words[p.index].text === p.text));

    // ── The folded "Other" tail is not a word ────────────────────────────────────
    ok('drift guard: the port\'s cap and label ARE categoryKey\'s',
      wc.WC_CATEGORY_CAP === categoryKey.CATEGORY_CAP && wc.WC_OTHER_LABEL === categoryKey.OTHER_LABEL,
      JSON.stringify([wc.WC_CATEGORY_CAP, categoryKey.CATEGORY_CAP, wc.WC_OTHER_LABEL, categoryKey.OTHER_LABEL]));
    const capped = Array.from({ length: categoryKey.CATEGORY_CAP }, (_, i) => 'w' + i).concat([categoryKey.OTHER_LABEL]);
    ok('a capped axis: its "Other" is the bucket', wc.wordCloudIsBucket(capped, capped.length - 1) && !wc.wordCloudIsBucket(capped, 0));
    ok('an uncapped axis: a category really called "Other" is a word', !wc.wordCloudIsBucket(['A', 'Other', 'B'], 1));

    expect(fails).toEqual([]);
    void failureCount;
  });
});
