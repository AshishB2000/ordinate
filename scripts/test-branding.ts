// Workspace BRANDING: the accent ramp's contrast in both themes, the logo gate,
// and the brand's path into an exported file.
//
//   · brandTokens (renderer/hub/chartPalette.ts), loaded in a vm the way the
//     hub loads it, for every swatch and a set of hostile seeds — each token
//     checked against WCAG contrast computed HERE, independently;
//   · validateLogo / saveLogo / readLogoDataUrl (src/app/branding.ts), on
//     real bytes in a temp dir;
//   · sanitizeStyle's accentHex/logo and sanitizeBundle's brand — the gate
//     between renderer input and a <style> block.
//
//   npm run build:ts && node scripts/test-branding.js

export {};
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');

const branding: typeof import('../src/app/branding') = require('../src/app/branding');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const dashExport: typeof import('../src/analysis/dashboardExport') = require('../src/analysis/dashboardExport');

const REPO = path.resolve(__dirname, '..');

// ── WCAG 2.x contrast, written out ──────────────────────────────────────────
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ── The accent ramp ─────────────────────────────────────────────────────────
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(REPO, 'renderer/hub/chartPalette.js'), 'utf8'), ctx);
const brandTokens = (hex: string): any => vm.runInContext(`brandTokens(${JSON.stringify(hex)})`, ctx);
const LIGHT_SURFACE = '#ffffff';
const DARK_SURFACES = vm.runInContext('BRAND_DARK_SURFACES', ctx) as string[];

// The renderer's swatches are main's (Settings paints one list, main validates the other).
const sfSrc = fs.readFileSync(path.join(REPO, 'renderer/hub/settingsFormats.ts'), 'utf8');
const sfList = sfSrc.slice(sfSrc.indexOf('const SF_SWATCHES'), sfSrc.indexOf('];', sfSrc.indexOf('const SF_SWATCHES')));
const sfHexes = (sfList.match(/#[0-9a-f]{6}/gi) || []).map((h) => h.toLowerCase());
ok('Settings offers exactly main\'s eight swatches', JSON.stringify(sfHexes) === JSON.stringify(branding.ACCENT_SWATCHES),
  JSON.stringify(sfHexes));

const HOSTILE = ['#ffff00', '#ffffff', '#000000', '#00ff00', '#808080', '#1a1a1a', '#ff00ff', '#7fffd4'];
for (const seed of [...branding.ACCENT_SWATCHES, ...HOSTILE]) {
  const t = brandTokens(seed);
  const L = t.light;
  const D = t.dark;
  const fails: string[] = [];
  if (contrast(L['--brand-accent'], '#ffffff') < 4.5) fails.push('light accent vs white text');
  for (let i = 1; i <= 5; i += 1) {
    if (contrast(L['--brand-chart-' + i], LIGHT_SURFACE) < 3) fails.push('light chart-' + i);
  }
  for (const s of DARK_SURFACES) {
    if (contrast(D['--brand-dk-accent'], s) < 4) fails.push('dark accent on ' + s);
    for (let i = 1; i <= 5; i += 1) {
      if (contrast(D['--brand-dk-chart-' + i], s) < 3) fails.push('dark chart-' + i + ' on ' + s);
    }
  }
  if (contrast(D['--brand-dk-accent'], '#ffffff') < 3) fails.push('dark accent vs white text');
  ok(`${seed}: every token reads in light AND dark`, fails.length === 0, fails.join('; '));
}
const blue = brandTokens('#2563eb');
ok('the app\'s own blue is left as it is in light (already passes)', blue.light['--brand-accent'] === '#2563eb',
  blue.light['--brand-accent']);
ok('a seed too pale for white text is darkened, not rejected',
  brandTokens('#ffff00').light['--brand-accent'] !== '#ffff00');
ok('soft/line/focus are rgba() of the accent', /^rgba\(\d+, \d+, \d+, 0\.08\)$/.test(blue.light['--brand-accent-soft']));
ok('a non-hex seed yields no tokens', brandTokens('red') === null && brandTokens('#12345') === null);

// applyBrandTokens sets them on an element, and '' takes every one away again.
{
  const props = new Map<string, string>();
  const el = { style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } };
  (ctx as any).__el = el;
  vm.runInContext(`applyBrandTokens(__el, '#7c3aed')`, ctx);
  const n = props.size;
  ok('applyBrandTokens sets the light and dark tokens', n > 10 && props.get('--brand-accent') !== undefined, String(n));
  vm.runInContext(`applyBrandTokens(__el, '')`, ctx);
  ok('…and clearing the accent removes all of them', props.size === 0, [...props.keys()].join(','));
}

// ── theme.css and hub.css read the tokens ───────────────────────────────────
const theme = fs.readFileSync(path.join(REPO, 'renderer/theme.css'), 'utf8');
ok('theme.css: --accent reads --brand-accent in light', /--accent:\s*var\(--brand-accent,/.test(theme));
ok('theme.css: --accent reads --brand-dk-accent in dark', /--accent:\s*var\(--brand-dk-accent,/.test(theme));
ok('theme.css: the chart ramp reads --brand-chart-1', /--chart-1:\s*var\(--brand-chart-1,/.test(theme));

// ── Branding settings ───────────────────────────────────────────────────────
const b = branding.sanitizeBranding({ accent: '#7C3AED', logo: 'gif', dashboardStyle: 'neon' });
ok('sanitizeBranding: hex lower-cased, unknown logo kind and preset dropped',
  b.accent === '#7c3aed' && b.logo === '' && b.dashboardStyle === 'auto', JSON.stringify(b));
ok('sanitizeBranding: a CSS injection is not an accent',
  branding.sanitizeBranding({ accent: '#fff;} body{display:none' }).accent === '');

// ── The logo gate ───────────────────────────────────────────────────────────
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);
const check = (buf: Buffer | null) => branding.validateLogo(buf);
const kind = (buf: Buffer | null) => { const r = check(buf); return r.ok ? r.kind : 'rejected'; };

ok('a PNG, by its signature', kind(PNG) === 'png');
ok('a plain SVG', kind(svg('<rect width="10" height="10" fill="#2563eb"/>')) === 'svg');
ok('an SVG behind an XML declaration and a comment',
  kind(Buffer.from('<?xml version="1.0"?>\n<!-- mark -->\n<svg viewBox="0 0 1 1"></svg>')) === 'svg');
ok('an SVG with an internal #fragment reference', kind(svg('<use href="#a"/>')) === 'svg');
ok('an SVG with <script> is refused', kind(svg('<script>alert(1)</script>')) === 'rejected');
ok('an SVG with an onload handler is refused', kind(svg('<rect onload="x()"/>')) === 'rejected');
ok('an SVG with a javascript: link is refused', kind(svg('<a href="javascript:x()"/>')) === 'rejected');
ok('an SVG with <foreignObject> is refused', kind(svg('<foreignObject/>')) === 'rejected');
ok('an SVG that loads a remote image is refused', kind(svg('<image href="https://x.test/a.png"/>')) === 'rejected');
ok('…or a protocol-relative one', kind(svg('<image xlink:href="//x.test/a.png"/>')) === 'rejected');
ok('a JPEG is refused', kind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])) === 'rejected');
ok('text named .png is refused (content, not name)', kind(Buffer.from('hello')) === 'rejected');
ok('an empty file is refused', kind(Buffer.alloc(0)) === 'rejected' && kind(null) === 'rejected');
const big = Buffer.concat([PNG, Buffer.alloc(branding.LOGO_MAX_BYTES)]);
const bigRes = check(big);
ok('over 512 KB is refused, and says the limit', !bigRes.ok && /512 KB/.test((bigRes as any).error), JSON.stringify(bigRes));
ok('exactly 512 KB is kept', kind(Buffer.concat([PNG, Buffer.alloc(branding.LOGO_MAX_BYTES - PNG.length)])) === 'png');

// Storage: atomic, one kind per scope, scope names never become paths.
async function storage(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-brand-'));
  try {
    const saved = await branding.saveLogo(dir, 'workspace', PNG);
    ok('saveLogo keeps a PNG', saved.ok && (saved as any).kind === 'png');
    const url = await branding.readLogoDataUrl(dir, 'workspace');
    ok('…and reads it back as a data: URL', typeof url === 'string' && url.startsWith('data:image/png;base64,'), String(url).slice(0, 40));
    await branding.saveLogo(dir, 'workspace', svg(''));
    const files = fs.readdirSync(path.join(dir, 'branding')).sort();
    ok('replacing with an SVG removes the PNG, and leaves no temp file', JSON.stringify(files) === '["logo.svg"]', JSON.stringify(files));
    const id = '0b6c7c4e-2f7a-4d53-9d2e-6a1f1b2c3d4e';
    ok('a dashboard\'s own logo is stored by its id', (await branding.saveLogo(dir, id, PNG)).ok
      && fs.existsSync(path.join(dir, 'branding', `dash-${id}.png`)));
    const bad = await branding.saveLogo(dir, '../../etc/x', PNG);
    ok('a scope that is not "workspace" or a UUID is refused', !bad.ok);
    const refused = await branding.saveLogo(dir, 'workspace', svg('<script/>'));
    ok('saveLogo refuses what validateLogo refuses, and keeps the old one',
      !refused.ok && fs.existsSync(path.join(dir, 'branding', 'logo.svg')));
    await branding.removeLogo(dir, 'workspace');
    ok('removeLogo clears it', (await branding.readLogoDataUrl(dir, 'workspace')) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── A dashboard's override, and the brand in an exported file ───────────────
const st = dashboards.sanitizeStyle({ theme: 'dark', density: 'compact', accent: 'teal', accentHex: '#ABCDEF', logo: 'custom', chosen: true });
ok('sanitizeStyle keeps a hex accent (lower-cased) and a logo choice',
  st.accentHex === '#abcdef' && st.logo === 'custom', JSON.stringify(st));
const st2 = dashboards.sanitizeStyle({ accentHex: 'red', logo: 'http://x' });
ok('…and drops a colour name and an unknown logo', !('accentHex' in st2) && !('logo' in st2), JSON.stringify(st2));

const ramp = { accent: '#6d28d9', accent2: '#5b21b6', soft: 'rgba(109, 40, 217, 0.08)', line: 'rgba(109, 40, 217, 0.22)',
  chart: ['#6d28d9', '#0e7490', '#14b8a6', '#6366f1', '#64748b'] };
const logo = 'data:image/png;base64,' + PNG.toString('base64');
const kept = dashExport.sanitizeBundle({ name: 'D', pages: [], brand: { ramp, logo, extra: 'x' } });
ok('sanitizeBundle keeps a valid ramp and logo, nothing else',
  JSON.stringify(kept.brand) === JSON.stringify({ ramp, logo }), JSON.stringify(kept.brand));
const hostile = dashExport.sanitizeBundle({ name: 'D', pages: [], brand: {
  ramp: { ...ramp, accent: '#fff;} body{display:none' }, logo: 'https://x.test/logo.png' } });
ok('one hostile colour drops the WHOLE ramp, and a remote logo is dropped',
  JSON.stringify(hostile.brand) === '{}', JSON.stringify(hostile.brand));
ok('a short ramp is dropped', JSON.stringify(dashExport.sanitizeBundle({ brand: { ramp: { ...ramp, chart: ['#000000'] } } }).brand) === '{}');
const html = dashExport.buildSelfContainedHtml({ name: 'D', pages: [], brand: { ramp, logo } }, '');
ok('the exported file paints the brand ramp', html.includes('--accent: #6d28d9') && html.includes("'#6d28d9'"));
ok('…and carries the logo for its header', html.includes(logo) && html.includes('dash-logo'));
const plain = dashExport.buildSelfContainedHtml({ name: 'D', pages: [] }, '');
ok('no brand: the named accent\'s own ramp, as before', plain.includes('--accent: #2563eb') && !plain.includes('"logo"'));

storage().then(() => {
  if (!failureCount()) console.log('\nAll branding checks passed.');
  finish();
}).catch((err) => {
  ok('storage checks ran', false, String(err && err.stack || err));
  finish();
});
