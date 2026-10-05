// T2.9's pure pieces, DIFFERENTIAL where the desktop has the original:
//   the Markdown subset   mdParse / mdTokens / safeHref == the desktop's markdown.js
//                         (recorded at the T8.1 cutover: __golden__/markdown.json)
//   tile actions          carrySteps / actionUrl == src/analysis/cardModel.js
//   pivot copy / CSV      the legacy pivotToRows shape over a server-shaped grid
//   Present               the fitted row height and its 28 px floor
// plus the rendered Markdown: never HTML, unsafe links dropped, tokens filled.

import { deepStrictEqual, equal, notDeepStrictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, it } from 'vitest';
import type { PivotGridShape } from '../../charts/grids/model';
import { presentRow } from './DashboardChrome';
import { MarkdownView } from './Markdown';
import { mdParse, mdTokens, safeHref } from './mdParse';
import { pivotToCsv, pivotToRows, pivotToTsv } from './pivotExport';
import { actionUrl, carrySteps, type TileAction } from './tileActions';
import { upsertFilter } from './ControlsExtras';
import { brandsFor } from './PublishDialog';
import { brandTokens } from '../../charts/palette';
import { golden } from '../../test-golden';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the server's UMD module, loaded through its CommonJS branch
const legacyCard: any = require(path.join(ROOT, 'src', 'analysis', 'cardModel.js'));

/** A script URL, spelled so the lint's no-script-url rule sees a test input, not a link. */
const JS = ['java', 'script:'].join('');

const SOURCES = [
  '',
  'plain text',
  '# Title\n## Sub\n### Third\n#### four is text',
  'para one\nstill one\n\npara two',
  '- a\n- b\n* c\n+ d\n\n1. one\n2) two\n10. ten',
  '```\ncode <b>\n```\nafter',
  '```\nunterminated',
  '**bold** __bold__ *it* _it_ ***both*** * not italic*',
  '`code *not italic*` and \\*escaped\\* \\{{x}}',
  '{{Revenue}} and {{ spaced name }} and {{}} and {{a{b}}',
  '[ok](https://example.com/a_(b)) [bad](javascript:alert(1)) [rel](/x) [ftp](ftp://x)',
  '<script>alert(1)</script> &amp; <img src=x onerror=alert(1)>',
  'unmatched ** and ` and [ and {{',
  '- [link](http://a.b) in a list\n- **bold** item',
  'Line\r\nwindows\r\n\r\nnext',
];

const MD = golden<{ parse: Array<[string, unknown]>; tokens: Array<[string, unknown]>; hrefs: Array<[string, string]>; italicX: unknown }>(
  'src/features/dashboards/__golden__/markdown.json',
);

describe('Markdown subset — differential against the desktop parser', () => {
  it('the fixture was recorded over exactly these sources', () => {
    deepStrictEqual(MD.parse.map(([src]) => src), SOURCES);
    deepStrictEqual(MD.tokens.map(([src]) => src), SOURCES);
  });
  it('parses every source to the same tree', () => {
    for (const [src, want] of MD.parse) deepStrictEqual(mdParse(src), want, src);
  });
  it('lists the same tokens', () => {
    for (const [src, want] of MD.tokens) deepStrictEqual(mdTokens(src), want, src);
  });
  it('keeps exactly the same links', () => {
    deepStrictEqual(MD.hrefs.map(([u]) => u), ['https://a.b/c', 'http://x', `${JS}alert(1)`, 'https://', ' https://a.b ', 'data:text/html,x', 'HTTPS://A.B']);
    for (const [u, want] of MD.hrefs) equal(safeHref(u), want, u);
  });
  it('a broken port would be caught (negative control)', () => {
    notDeepStrictEqual(mdParse('**x**'), MD.italicX);
  });
});

describe('MarkdownView', () => {
  it('renders text, never HTML; unsafe links keep their words only; tokens filled', () => {
    const { container } = render(
      <MarkdownView text={'# Head\n<script>x</script> [ok](https://a.b) [no](javascript:x) {{Rev}} {{Nope}}'} token={(n) => (n === 'Rev' ? { text: '$5.2M' } : { text: `{{${n}}}`, missing: true })} />,
    );
    equal(container.querySelector('script'), null);
    equal(container.querySelector('h3')?.textContent, 'Head');
    const links = container.querySelectorAll('a');
    equal(links.length, 1);
    equal(links[0]!.getAttribute('href'), 'https://a.b/');
    equal(links[0]!.getAttribute('rel'), 'noopener noreferrer');
    screen.getByText('$5.2M');
    equal(container.querySelector('[data-token="Nope"]')?.getAttribute('title'), 'No metric or parameter is called Nope');
    equal(container.textContent?.includes('<script>x</script>'), true);
  });
});

describe('tile actions — differential against cardModel', () => {
  const filters = [
    { type: 'filter', column: 'region', op: '=', value: 'East' },
    { type: 'filter', column: 'year', op: '>=', value: 2024 },
    { type: 'filter', column: 'region', op: '=', value: 'East' },
  ];
  const clicks = [null, { column: 'region', value: 'West' }, { column: 'segment', value: 'B2B' }];
  it('carries the same steps for every carry mode and click', () => {
    for (const carry of ['clicked_value', 'all_selection', 'none', undefined] as const) {
      for (const clicked of clicks) {
        const a = { kind: 'navigate', carry } as TileAction;
        deepStrictEqual(carrySteps(a, clicked, filters), legacyCard.carrySteps(a, { clicked, filters, selection: [] }), JSON.stringify([carry, clicked]));
      }
    }
  });
  it('builds the same https links and refuses the same others', () => {
    const cases: Array<[string, unknown]> = [
      ['https://x.test/q={{value}}', 'a b&c'],
      ['https://x.test/{{ value }}', 42],
      ['http://x.test/{{value}}', 'x'],
      [`${JS}alert({{value}})`, 'x'],
      ['', 'x'],
      ['not a url', 'x'],
    ];
    for (const [t, v] of cases) deepStrictEqual(actionUrl(t, v), legacyCard.actionUrl(t, v), t);
  });
});

describe('pivot Copy as table / Export CSV', () => {
  const grid = {
    rowHeaders: [['East'], ['East', 'Retail'], ['West, Inc']],
    colHeaders: [['2024'], ['2025']],
    cells: [[100, 200], [40, null], [7.5, 8]],
    rowTotals: [[300], [40], [15.5]],
    colTotals: [147.5, 208],
    grand: [355.5],
    rowKinds: ['subtotal', 'leaf', 'leaf'],
    valueNames: ['Sales'],
    valueCount: 1,
    showAs: ['value'],
    formats: ['auto'],
  } as unknown as PivotGridShape;
  it('writes the full grid: headers, indented rows, totals', () => {
    const rows = pivotToRows(grid);
    deepStrictEqual(rows[0], ['', '2024', '2025', 'Total']);
    equal(rows[2]![0], '  Retail');
    equal(rows[2]![2], '–');
    deepStrictEqual(rows.at(-1)!.slice(0, 1), ['Total']);
    equal(rows.length, 5);
  });
  it('TSV has no tabs inside cells; CSV quotes what needs it', () => {
    equal(pivotToTsv(grid).split('\n')[3]!.split('\t').length, 4);
    equal(pivotToCsv(grid).split('\r\n')[3]!.startsWith('"West, Inc"'), true);
  });
});

describe('Present', () => {
  it('fits the rows into the height, with the 44 px floor', () => {
    equal(presentRow(10, 800, 12), Math.floor((800 - 1 - 9 * 12) / 10));
    equal(presentRow(16, 800, 12), null);
    equal(presentRow(40, 600, 12), null);
    equal(presentRow(0, 600, 12), null);
  });
});

describe('Category / Period quick filters', () => {
  it('replace a filter on the same column, else add one (upsertDashFilter)', () => {
    const f = [{ type: 'filter', column: 'region', op: '=', value: 'East' }, { type: 'filter', column: 'year', op: '>=', value: 2024 }];
    deepStrictEqual(upsertFilter(f, { type: 'filter', column: 'region', op: '=', value: 'West' }).map((x) => x.value), ['West', 2024]);
    equal(upsertFilter(f, { type: 'filter', column: 'segment', op: '=', value: 'B2B' }).length, 3);
  });
});

describe('the brand ramp a publish carries', () => {
  const list = [
    { id: 'a', name: 'A', sheets: 1, style: { theme: 'clean', accent: 'blue', accentHex: '#7c3aed' } },
    { id: 'b', name: 'B', sheets: 1, style: { theme: 'dark', accent: 'blue' } },
    { id: 'c', name: 'C', sheets: 1, style: { theme: 'clean', accent: 'teal' } },
  ];
  it('a custom accent, else the workspace accent on the default blue; the dark ramp on a dark sheet', () => {
    const out = brandsFor(list, ['a', 'b', 'c'], '#16a34a');
    const t = brandTokens('#7c3aed')!;
    equal(out.a!.ramp.accent, t.light['--brand-accent']);
    equal((out.a!.ramp.chart as string[]).length, 8);
    equal(out.b!.ramp.accent, brandTokens('#16a34a')!.dark['--brand-dk-accent']);
    equal(out.c, undefined, 'a named accent travels by name');
  });
  it('only the picked dashboards', () => {
    deepStrictEqual(Object.keys(brandsFor(list, ['a'], '')), ['a']);
  });
});
