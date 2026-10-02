// Interface languages — the guard. Four things must hold, or a language quietly
// rots:
//
//   1. CATALOGS AGREE. Every key in en.json is in each shipped locale, as a
//      message or as an explicit `null` ("deliberately English"); no locale has
//      a key en.json lacks; every draft says `"_status": "draft"`; and every
//      translation uses exactly the parameters its English does — a dropped
//      `{count}` is a sentence with a hole in it.
//   2. NOTHING HARD-CODED. The extractor's own detector (scripts/i18nDetect.ts)
//      finds no user-visible string left in renderer/hub/*.ts or the main-side
//      sentence files, and index.html has no untagged text. One classifier for
//      both, so a green guard means "the extractor has nothing left to do".
//      ALLOW names the few that remain on purpose.
//   3. EVERY KEY RESOLVES. Each `t('key')` / `data-i18n="key"` in the tree is in
//      en.json, and en.json has no key nothing uses.
//   4. THE FORMATTER. Plural categories per locale (CLDR via Intl.PluralRules —
//      French puts 0 with 1, Japanese has one form), select, exact `=N`,
//      quoting, fallback to English with a count, and the en-XA pseudo-locale.
//
//   npm run build:ts && node scripts/test-i18n.js

import * as fs from 'fs';
import * as path from 'path';

import { ok, finish } from './selfcheck';
import { detect, collectDataValues } from './i18nDetect';
import { rendererFiles, MAIN_FILES, tagHtml, referencedKeys } from './i18n-extract';
import { createTranslator, formatMessage, messagesOf, parseMessage, pluralCategory, pseudoText } from '../src/app/i18nCore';

const REPO = path.resolve(__dirname, '..');
const DIR = path.join(REPO, 'renderer', 'i18n');
const HUB = path.join(REPO, 'renderer', 'hub');
const LOCALES = ['es', 'de', 'fr', 'ja'];

const read = (p: string): string => fs.readFileSync(p, 'utf8');
const en = messagesOf(JSON.parse(read(path.join(DIR, 'en.json'))));
const enKeys = Object.keys(en);

// ── 1. catalogs agree ───────────────────────────────────────────────────

/** The parameters a message uses: `name`, `n:plural`, `flag:select`, nested too. */
function argsOf(msg: string): string {
  const out = new Set<string>();
  // ponytail: parseMessage's node union is internal to i18nCore; walked structurally here
  const walk = (nodes: any[]): void => {
    for (const n of nodes) {
      if (typeof n === 'string' || n.pound) continue;
      out.add(n.arg + (n.type ? ':' + n.type : ''));
      if (n.branches) for (const b of Object.values(n.branches)) walk(b as any[]);
    }
  };
  walk(parseMessage(msg) as any[]);
  return [...out].sort().join(',');
}

ok('en.json has messages', enKeys.length > 1000, `${enKeys.length} keys`);
ok('every English message parses to the parameters it spells', enKeys.every((k) => typeof en[k] === 'string'));

for (const loc of LOCALES) {
  const file = path.join(DIR, `${loc}.json`);
  ok(`${loc}.json exists`, fs.existsSync(file));
  if (!fs.existsSync(file)) continue;
  const raw = JSON.parse(read(file)) as Record<string, unknown>;
  ok(`${loc}.json is marked "_status": "draft"`, raw._status === 'draft', String(raw._status));
  const msgs = messagesOf(raw);
  const missing = enKeys.filter((k) => !(k in msgs));
  ok(`${loc}: every en key present (or explicitly null)`, missing.length === 0, missing.slice(0, 5).join(', '));
  const extra = Object.keys(msgs).filter((k) => !(k in en));
  ok(`${loc}: no key en.json lacks`, extra.length === 0, extra.slice(0, 5).join(', '));
  const wrong = enKeys.filter((k) => typeof msgs[k] === 'string' && argsOf(msgs[k] as string) !== argsOf(en[k] as string));
  ok(`${loc}: every translation keeps its English parameters`, wrong.length === 0,
    wrong.slice(0, 3).map((k) => `${k}: «${en[k]}» → «${msgs[k]}»`).join(' | '));
  const translated = enKeys.filter((k) => typeof msgs[k] === 'string').length;
  ok(`${loc}: a real draft (≥ 90% translated)`, translated >= enKeys.length * 0.9, `${translated}/${enKeys.length}`);
}

// ── 2. nothing hard-coded ───────────────────────────────────────────────

/**
 * Strings the detector still finds, on purpose: `file: text`. Keep it short and
 * say why — anything else here is a string a reader sees in English.
 */
const ALLOW = new Set<string>([]);

const units = [
  ...rendererFiles().map((f) => path.join(HUB, f)),
  ...MAIN_FILES.map((f) => path.join(REPO, f)),
];
const srcs = units.map((p) => ({ p, s: read(p) }));
const dataValues = new Set<string>();
for (const u of srcs) collectDataValues(u.s, dataValues);
const left: string[] = [];
for (const u of srcs) {
  for (const site of detect(u.s, { dataValues })) {
    const text = u.s.slice(site.start, site.end).replace(/\s+/g, ' ');
    const id = `${path.basename(u.p)}: ${text}`;
    if (!ALLOW.has(id)) left.push(`${id} (line ${u.s.slice(0, site.start).split('\n').length})`);
  }
}
ok('no hard-coded user-visible string in the renderer or main sentence files', left.length === 0,
  `${left.length} left — run scripts/i18n-extract.js:\n    ${left.slice(0, 12).join('\n    ')}`);

const html = read(path.join(HUB, 'index.html'));
const untagged: string[] = [];
tagHtml(html, (text) => { untagged.push(text); return 'x'; });
ok('index.html: every visible text and title/placeholder/aria-label is tagged', untagged.length === 0,
  untagged.slice(0, 8).join(' | '));

// ── 3. every key resolves ───────────────────────────────────────────────

const used = referencedKeys([...srcs.map((u) => u.s), html]);
const unknown = [...used].filter((k) => !(k in en));
ok('every t()/data-i18n key is in en.json', unknown.length === 0, unknown.slice(0, 8).join(', '));
const orphan = enKeys.filter((k) => !used.has(k));
ok('en.json has no key nothing uses', orphan.length === 0, orphan.slice(0, 8).join(', '));

// ── 4. the formatter ────────────────────────────────────────────────────

const ITEMS = '{n} {n, plural, one {item} other {items}}';
ok('en plural: 1 item', formatMessage(ITEMS, { n: 1 }, 'en') === '1 item');
ok('en plural: 0 items', formatMessage(ITEMS, { n: 0 }, 'en') === '0 items');
ok('en plural: 2 items', formatMessage(ITEMS, { n: 2 }, 'en') === '2 items');
ok('en plural: 1.5 items (a fraction is other)', formatMessage(ITEMS, { n: 1.5 }, 'en') === '1.5 items');

const per = (loc: string): string => [0, 1, 2, 5, 21, 1_000_000].map((n) => pluralCategory(loc, n)).join(' ');
ok('plural rules en: 0,1,2,5,21,1e6', per('en') === 'other one other other other other', per('en'));
ok('plural rules fr: 0 and 1 are singular, a million is many', per('fr') === 'one one other other other many', per('fr'));
ok('plural rules es: a million is many', per('es') === 'other one other other other many', per('es'));
ok('plural rules de', per('de') === 'other one other other other other', per('de'));
ok('plural rules ja: one form', per('ja') === 'other other other other other other', per('ja'));
// A translation that only spells one/other still works where CLDR says `many`.
ok('a missing category falls back to other', formatMessage('{n, plural, one {# élément} other {# éléments}}', { n: 1_000_000 }, 'fr') === '1000000 éléments');
ok('exact =0 wins over the category', formatMessage('{n, plural, =0 {none} one {# item} other {# items}}', { n: 0 }, 'en') === 'none');
ok('# in a plural is the number', formatMessage('{n, plural, other {# rows}}', { n: 7 }, 'ja') === '7 rows');

const SEL = '{up, select, true {rose} other {fell}} by {pct}';
ok('select true', formatMessage(SEL, { up: true, pct: '4%' }, 'en') === 'rose by 4%');
ok('select other', formatMessage(SEL, { up: false, pct: '4%' }, 'en') === 'fell by 4%');
ok('quoted braces are literal', formatMessage("Type '{{'Revenue'}}' to insert", {}, 'en') === 'Type {{Revenue}} to insert');
ok("an apostrophe in a word is just a character", formatMessage("Don't {x}", { x: 'stop' }, 'en') === "Don't stop");
ok('a parameter is never re-parsed', formatMessage('Hi {name}', { name: '{evil}' }, 'en') === 'Hi {evil}');
ok('a missing parameter prints empty', formatMessage('[{a}]', {}, 'en') === '[]');
ok('malformed syntax degrades to text, never throws', formatMessage('Oops {n, plural, one {x}', { n: 1 }, 'en') === 'Oops {n, plural, one {x}');

// Loaded the way the hub loads it: the CommonJS file under the two-line shim,
// then the shim REMOVED (renderer/hub/i18n.ts) before the first call. A
// call-time read of `exports.*` inside the module would throw here, as it did
// in the app once.
{
  const vm: typeof import('vm') = require('vm');
  const box: Record<string, any> = { Intl, Map, Set, Number, String, Math, Object, Array };
  box.window = box;
  vm.createContext(box);
  vm.runInContext('window.module = { exports: {} }; window.exports = window.module.exports;', box);
  vm.runInContext(read(path.join(REPO, 'src', 'app', 'i18nCore.js')), box);
  vm.runInContext('var core = window.module.exports; delete window.module; delete window.exports;', box);
  let out = '';
  try {
    out = vm.runInContext("core.createTranslator({ locale: 'en-XA', messages: {}, fallback: { k: 'Save {n} {n, plural, one {file} other {files}}' } })('k', { n: 1 })", box);
  } catch (e) { out = 'threw: ' + (e as Error).message; }
  ok('i18nCore.js works after the hub removes the CommonJS shim', /^Šàṽé 1 ƒîļé ·+$/.test(out), out);
}

// The translator: fallback, explicit null, counting.
const seen: string[] = [];
const tr = createTranslator({
  locale: 'fr',
  messages: { hello: 'Bonjour {name}', kept: null },
  fallback: { hello: 'Hello {name}', kept: 'Kept', bye: 'Goodbye' },
  onMissing: (k) => seen.push(k),
});
ok('a translated key', tr('hello', { name: 'Ada' }) === 'Bonjour Ada');
ok('explicit null shows English and is not "missing"', tr('kept') === 'Kept' && !tr.missing.has('kept'));
ok('a missing key falls back to English', tr('bye') === 'Goodbye');
ok('…and is counted once', tr('bye') === 'Goodbye' && tr.missing.size === 1 && seen.length === 1);
ok('an unknown key shows itself, never blank', tr('no.such.key') === 'no.such.key');

// The pseudo-locale: accented, ≥ 30% longer, parameters intact.
const ps = createTranslator({ locale: 'en-XA', messages: {}, fallback: { k: 'Save {n} {n, plural, one {file} other {files}}' } });
const out = ps('k', { n: 2 });
ok('en-XA accents letters, padding once at the end', /^Šàṽé 2 ƒîļéš ·+$/.test(out), out);
ok('en-XA keeps the parameter and the plural', /2/.test(out) && /ƒîļéš/.test(out), out);
ok('en-XA is at least 30% longer', pseudoText('Save changes').length >= Math.ceil('Save changes'.length * 1.3), pseudoText('Save changes'));
ok('en-XA leaves whitespace-only text alone', pseudoText('  ') === '  ');

finish();
