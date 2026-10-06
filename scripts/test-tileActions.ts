// Self-check for tile actions and the Navigation card — the pure model in
// src/analysis/cardModel.ts, and that main's sanitizeCard keeps what it should.
//
//   npm run build:ts && node scripts/test-tileActions.js

import { ok, failureCount, finish } from './selfcheck';
import { sanitizeCard } from '../src/analysis/dashboards';

// ponytail: cardModel.js is a UMD script, not a TS module (see test-geo-match.ts)
const cm = require('../src/analysis/cardModel') as any;

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── Sanitize ─────────────────────────────────────────────────────────────────
{
  const a = cm.sanitizeAction({ kind: 'navigate', trigger: 'bogus', carry: 'everything', target: { analysisId: ID(1), page: 'not-a-uuid' } });
  ok('sanitize: an unknown trigger defaults to click', a.trigger === 'click');
  ok('sanitize: an unknown carry defaults to clicked_value', a.carry === 'clicked_value');
  ok('sanitize: a malformed page id is dropped, the dashboard kept', a.target.analysisId === ID(1) && a.target.page === undefined);
  ok('sanitize: an unknown kind is refused', cm.sanitizeAction({ kind: 'exec', url: 'x' }) === null);
  const incomplete = cm.sanitizeAction({ kind: 'navigate' });
  ok('sanitize: an INCOMPLETE action is kept for the editor to finish', incomplete !== null && !incomplete.target);
  const many = cm.sanitizeActions(Array.from({ length: 20 }, () => ({ kind: 'url', url: 'https://a.b' })));
  ok('sanitize: at most eight actions', many.length === 8);
  const tiles = cm.sanitizeAction({ kind: 'filter_target', tiles: [ID(2), ID(2), '../x', ID(3)] });
  ok('sanitize: tile ids are UUID-checked and de-duplicated', JSON.stringify(tiles.tiles) === JSON.stringify([ID(2), ID(3)]));
}

// ── Carry semantics ──────────────────────────────────────────────────────────
{
  const filters = [
    { type: 'filter', column: 'region', op: '=', value: 'West' },
    { type: 'filter', column: 'units', op: '>', value: 2 },
  ];
  const selection = [{ type: 'filter', column: 'units', op: '>', value: 2 }, { type: 'filter', column: 'state', op: '=', value: 'Ohio' }];
  const clicked = { column: 'category', value: 'Technology' };
  const ctx = { clicked, filters, selection };
  ok('carry none: nothing travels', cm.carrySteps({ carry: 'none' }, ctx).length === 0);
  const cv = cm.carrySteps({ carry: 'clicked_value' }, ctx);
  ok('carry clicked_value: exactly the clicked value, as an equality',
    cv.length === 1 && cv[0].column === 'category' && cv[0].op === '=' && cv[0].value === 'Technology');
  ok('carry clicked_value from a menu (no mark): nothing', cm.carrySteps({ carry: 'clicked_value' }, { filters }).length === 0);
  const all = cm.carrySteps({ carry: 'all_selection' }, ctx);
  ok('carry all_selection: filters, selection, then the click — duplicates once',
    JSON.stringify(all.map((s: any) => s.column)) === JSON.stringify(['region', 'units', 'state', 'category']), JSON.stringify(all));
  const onRegion = cm.carrySteps({ carry: 'all_selection' }, { clicked: { column: 'region', value: 'East' }, filters });
  ok('carry all_selection: a click on a filtered column REPLACES its equality filter',
    onRegion.filter((s: any) => s.column === 'region').length === 1 && onRegion[onRegion.length - 1].value === 'East', JSON.stringify(onRegion));
  ok('carry: a number value stays a number', cm.carrySteps({ carry: 'clicked_value' }, { clicked: { column: 'year', value: 2024 } })[0].value === 2024);
}

// ── URLs: encoding and scheme refusal ────────────────────────────────────────
{
  const r = cm.actionUrl('https://example.com/search?q={{value}}&x=1', 'A&B C/é?#');
  ok('url: {{value}} is URL-encoded into the query', r.ok && r.url === 'https://example.com/search?q=A%26B%20C%2F%C3%A9%3F%23&x=1', JSON.stringify(r));
  ok('url: spaces inside the braces are allowed', cm.actionUrl('https://x.org/{{ value }}', 'a b').url === 'https://x.org/a%20b');
  ok('url: every occurrence is replaced', cm.actionUrl('https://x.org/{{value}}/{{value}}', 'q').url === 'https://x.org/q/q');
  // Assembled, not literal: the lint rule against script URLs cannot tell a
  // refusal test from a use.
  const SCRIPT_URL = ['javascript', 'alert(1)'].join(':');
  for (const bad of ['http://example.com/{{value}}', SCRIPT_URL, 'file:///etc/passwd', 'data:text/html,hi', 'ftp://x.org', '']) {
    const res = cm.actionUrl(bad, 'x');
    ok(`url: refuses ${JSON.stringify(bad)}`, res.ok === false, JSON.stringify(res));
  }
  const inj = cm.actionUrl('{{value}}', SCRIPT_URL);
  ok('url: a VALUE cannot supply a scheme', inj.ok === false);
  const host = cm.actionUrl('https://{{value}}.example.com/', 'evil.com/x?');
  ok('url: a value cannot break out of its slot into the path', !host.ok || new URL(host.url).pathname === '/', JSON.stringify(host));
  ok('url: a null value is the empty string', cm.actionUrl('https://x.org/?q={{value}}', null).url === 'https://x.org/?q=');
}

// ── Validation: dangling references become warnings ──────────────────────────
{
  const ctx = {
    analyses: [{ id: ID(10), name: 'Retail overview', pages: [{ id: ID(11), name: 'Main' }] }],
    visualIds: [ID(20)],
    tileIds: [ID(30)],
  };
  const w = cm.validateActions([
    { kind: 'navigate', target: { analysisId: ID(10) } },
    { kind: 'navigate', target: { analysisId: ID(99) } },
    { kind: 'navigate', target: { analysisId: ID(10), page: ID(98) } },
    { kind: 'navigate' },
    { kind: 'url', url: 'http://plain.org' },
    { kind: 'filter_target', tiles: [ID(30), ID(31), ID(32)] },
    { kind: 'filter_target' },
    { kind: 'tooltip_visual', tooltipVisualId: ID(21) },
    { kind: 'tooltip_visual', tooltipVisualId: ID(20) },
  ], ctx);
  ok('validate: a live target has no warning', w[0].length === 0);
  ok('validate: a deleted dashboard is a warning', /no longer exists/.test(w[1][0]));
  ok('validate: a deleted page says where it will open instead', /first page/.test(w[2][0]));
  ok('validate: no target yet asks for one', /Choose a dashboard/.test(w[3][0]));
  ok('validate: an http link is refused by the same rule that opens it', /https/.test(w[4][0]));
  ok('validate: two of three target tiles are gone', w[5][0] === '2 target tiles no longer exist.', w[5].join());
  ok('validate: a narrow with no tiles asks for them', /Choose the tiles/.test(w[6][0]));
  ok('validate: a deleted tooltip visual is a warning', /no longer exists/.test(w[7][0]));
  ok('validate: a live tooltip visual has none', w[8].length === 0);
}

// ── The Navigation card ──────────────────────────────────────────────────────
{
  const nav = cm.sanitizeNav({ style: 'weird', items: [
    { label: '  Sales  ', icon: 'chart-bar', target: { analysisId: ID(10) }, carry: { column: 'region', value: 'West' } },
    { label: '', icon: 'rm -rf', carry: { column: 'x', value: { evil: 1 } } },
  ] });
  ok('nav: an unknown style is buttons', nav.style === 'buttons');
  ok('nav: labels are trimmed; an empty one reads Open', nav.items[0].label === 'Sales' && nav.items[1].label === 'Open');
  ok('nav: an unknown icon is dropped', nav.items[1].icon === undefined && nav.items[0].icon === 'chart-bar');
  ok('nav: a carried filter needs a column and a plain value', nav.items[0].carry.value === 'West' && nav.items[1].carry === undefined);
  const w = cm.validateNav({ style: 'buttons', items: [{ target: { analysisId: ID(10) } }, { target: { analysisId: ID(99) } }] },
    { analyses: [{ id: ID(10), name: 'x', pages: [] }] });
  ok('nav: a button to a deleted dashboard warns', w[0].length === 0 && /no longer exists/.test(w[1][0]));
  ok('nav: Back to overview needs no target', cm.validateNav({ style: 'back', items: [{ label: 'Back' }] }, { analyses: [] })[0].length === 0);
}

// ── Main keeps what the editor writes ────────────────────────────────────────
{
  const layout = { x: 0, y: 0, w: 6, h: 4 };
  const v = sanitizeCard({ id: ID(40), type: 'visual', visualId: ID(20), layout, actions: [{ kind: 'url', url: 'https://x.org/{{value}}', trigger: 'menu' }] });
  ok('sanitizeCard: a visual card keeps its actions', !!v && Array.isArray(v.actions) && v.actions[0].trigger === 'menu');
  const n = sanitizeCard({ id: ID(41), type: 'nav', layout, nav: { style: 'tabs', items: [{ label: 'A' }] } });
  ok('sanitizeCard: a navigation card survives the whitelist', !!n && n.type === 'nav' && n.nav.style === 'tabs');
  ok('sanitizeCard: an unknown kind is still dropped', sanitizeCard({ type: 'iframe', layout, src: 'https://x' }) === null);
  const t = sanitizeCard({ id: ID(42), type: 'text', layout, text: 'hi', actions: [{ kind: 'url', url: 'https://x' }] });
  ok('sanitizeCard: only a visual tile carries actions', !!t && t.actions === undefined);
}

console.log(failureCount() ? `\n${failureCount()} tile action check(s) FAILED.` : '\nAll tile action checks passed.');
finish();
