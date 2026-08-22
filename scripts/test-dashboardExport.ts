// Self-check for src/dashboardExport.ts (the PURE self-contained-HTML builder).
// Proves the generated file is OFFLINE and SELF-CONTAINED — the whitelisted bundle
// round-trips as inlined data, the supplied Chart.js UMD is inlined, the HTML shell is
// valid, and (the load-bearing invariant) it references NO http(s) URL and leaks NO
// secret: a sentinel placed in NON-whitelisted fields is stripped by sanitizeBundle,
// while legit app-computed labels/values survive. No Electron, no fs, no framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled sibling of the real pure module (built by pretest).
const { buildSelfContainedHtml, sanitizeBundle }: typeof import('../src/analysis/dashboardExport') = require('../src/analysis/dashboardExport');


// A recognizable, definitely-not-a-real-URL fake Chart.js UMD so the test never reads
// the 200 KB real file (and so the whole document is guaranteed http-free).
const FAKE_CHARTJS = 'window.Chart=function(){};/*FAKE-CHARTJS-UMD-MARKER*/';

// A sentinel that must NEVER reach the output — placed only in NON-whitelisted fields.
const SECRET = 'SECRET-apiKey-abc123XYZ';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const bundle = {
  name: 'Q3 Sales',
  // NON-whitelisted top-level field carrying the sentinel — must be dropped.
  apiKey: SECRET,
  // Task 5: a control's label + current value, flattened to plain text — the
  // ONLY trace of control state allowed into an export (never a live widget).
  controlsSummary: 'Region: West · Jan 1–Mar 31',
  pages: [
    {
      name: 'Overview',
      cards: [
        {
          kind: 'chart',
          layout: { x: 0, y: 0, w: 6, h: 4 },
          chartType: 'bar',
          title: 'Units by product',
          data: {
            labels: ['Widgets', 'Gadgets'],
            series: [{ label: 'Units', values: [42, 17] }],
          },
          // sentinel in a field the schema does NOT include → dropped
          connectionSecret: SECRET,
        },
        {
          kind: 'metric',
          layout: { x: 6, y: 0, w: 3, h: 2 },
          label: 'Revenue',
          value: 123456,
          token: SECRET, // non-whitelisted → dropped
        },
        { kind: 'text', layout: { x: 9, y: 0, w: 3, h: 2 }, heading: 'Notes', text: 'All good' },
        { kind: 'image', layout: { x: 0, y: 4, w: 6, h: 4 }, png: PNG, title: 'Map' },
        { kind: 'broken', layout: { x: 6, y: 4, w: 6, h: 4 }, reason: 'Source removed' },
        // an unknown card kind → dropped entirely
        { kind: 'totally-unknown', layout: { x: 0, y: 8, w: 1, h: 1 }, payload: SECRET },
      ],
    },
  ],
};

const html = buildSelfContainedHtml(bundle, FAKE_CHARTJS);

// ── Valid HTML shell ──────────────────────────────────────────────────────────
ok('starts with a doctype', /^<!doctype html>/i.test(html.trim()));
ok('has an <html> and closing </html>', /<html[\s>]/i.test(html) && html.includes('</html>'));
ok('has the render mount point', html.includes('id="dash-root"'));
ok('sets the title to the dashboard name', html.includes('<title>Q3 Sales</title>'));

// ── Chart.js UMD inlined (no external <script src>) ─────────────────────────────
ok('inlines the supplied Chart.js UMD', html.includes('FAKE-CHARTJS-UMD-MARKER'));
ok('has NO external script src', !/<script[^>]+\bsrc=/i.test(html));
ok('has NO external stylesheet link', !/<link[^>]+href=/i.test(html));

// ── Bundle round-trips as inlined data ──────────────────────────────────────────
const m = html.match(/window\.__DASHBOARD__ = (.+?);<\/script>/);
ok('embeds a window.__DASHBOARD__ assignment', !!m);
let parsed: any = null;
if (m) {
  try {
    parsed = JSON.parse(m[1]);
  } catch (e) {
    /* leave null → assertions below fail loudly */
  }
}
ok('inlined data is valid JSON that round-trips', !!parsed && parsed.name === 'Q3 Sales');
ok('inlined data keeps the chart labels/values', !!parsed
  && parsed.pages[0].cards[0].data.labels[0] === 'Widgets'
  && parsed.pages[0].cards[0].data.series[0].values[0] === 42);
ok('inlined data keeps the metric value', !!parsed && parsed.pages[0].cards[1].value === 123456);
ok('inlined data keeps the embedded PNG data-URI', !!parsed
  && parsed.pages[0].cards.some((c: any) => c.kind === 'image' && c.png === PNG));
ok('inlined data keeps the broken-card placeholder', !!parsed
  && parsed.pages[0].cards.some((c: any) => c.kind === 'broken' && c.reason === 'Source removed'));
ok('inlined data keeps the controls summary', !!parsed && parsed.controlsSummary === 'Region: West · Jan 1–Mar 31');

// ── Controls summary renders as a textContent-only subtitle, never a live widget ──
ok('renders the controls-summary subtitle element', html.includes('dash-controls-summary'));
ok('has NO <select>/<input> control widget anywhere (never a live control in an export)',
  !/<select[\s>]/i.test(html) && !/<input[\s>]/i.test(html));

// ── OFFLINE: no http(s) URL anywhere (a data: PNG is fine) ──────────────────────
ok('references NO http(s) URL (fully offline)', !/https?:\/\//i.test(html));

// ── SECRET-EXCLUSION: the sentinel in non-whitelisted fields is stripped ────────
ok('contains NO secret string (whitelist stripped every non-schema field)', !html.includes(SECRET));

// ── sanitizeBundle drops unknown fields + unknown card kinds ────────────────────
const clean = sanitizeBundle(bundle);
ok('sanitize drops the unknown top-level field', !('apiKey' in (clean as any)));
ok('sanitize keeps the controls summary string', clean.controlsSummary === 'Region: West · Jan 1–Mar 31');
ok('sanitize coerces a non-string controlsSummary to an empty string',
  sanitizeBundle({ ...bundle, controlsSummary: { evil: SECRET } }).controlsSummary === '');
ok('sanitize drops the unknown card kind', clean.pages[0].cards.every((c) => c.kind !== ('totally-unknown' as any)));
ok('sanitize keeps exactly the 5 known cards', clean.pages[0].cards.length === 5);
const chartCard: any = clean.pages[0].cards[0];
ok('sanitize strips the sentinel field off the chart card', !('connectionSecret' in chartCard));

// ── Robustness: garbage / empty input never throws ──────────────────────────────
ok('empty bundle yields one default page', sanitizeBundle({}).pages.length === 1);
ok('nullish bundle is handled', sanitizeBundle(null).name === 'Dashboard');
ok('a non-number chart value is coerced to null (never leaks a string)',
  sanitizeBundle({
    pages: [{ name: 'p', cards: [{ kind: 'chart', layout: {}, data: { labels: ['a'], series: [{ label: 's', values: ['not-a-number'] }] } }] }],
  }).pages[0].cards[0].data!.series[0].values[0] === null);

if (failureCount()) {
  console.error('\n' + failureCount() + ' dashboardExport check(s) FAILED');
  process.exit(1);
}
console.log('\nAll dashboardExport checks passed.');
