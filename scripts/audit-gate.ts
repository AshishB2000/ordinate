// The dependency-audit gate (T6.3): `npm audit --omit=dev` over the server and
// the web app, failing on any HIGH or CRITICAL advisory that is not on the
// short allowlist below. An allowlisted advisory is one with no fix inside the
// versions we may use and no path from the app to the vulnerable code — each
// entry says why, and the reason lives in docs/phase-7-web/threat-model.md §7.
//
// The list can only shrink honestly: the gate also fails on an entry past its
// review date, and on an entry that no longer appears in any audit (fixed
// upstream, or the package is gone) — delete it then, never extend it to pass.
//
//   npm run build:ts && node scripts/audit-gate.js . web

import { execFileSync } from 'child_process';

interface Allowed {
  readonly pkg: string;
  readonly reason: string;
  /** YYYY-MM-DD: after this date the entry fails the gate until re-reviewed. */
  readonly reviewBy: string;
}

const ALLOW: Readonly<Record<string, Allowed>> = {
  'GHSA-jrc7-96c5-q579': {
    pkg: 'maplibre-gl',
    reason: 'DOM.sanitize() bypass: the web app never calls setHTML (setDOMContent); the desktop popup escapes its input and goes at T8.1. Fix is v6; v4 is pinned (T1.3).',
    reviewBy: '2027-01-04',
  },
  'GHSA-5p2g-fcmc-qvqq': {
    pkg: 'image-size',
    reason: 'JXL/HEIF parser loop, via pptxgenjs: PPTX is built in the browser from our own PNGs. No fixed version (audit offers a downgrade).',
    reviewBy: '2027-01-04',
  },
  'GHSA-w3rx-r6r6-pgpr': {
    pkg: 'image-size',
    reason: 'ICNS parser loop, via pptxgenjs: as above — no ICNS image ever reaches it.',
    reviewBy: '2027-01-04',
  },
};

const GATE = new Set(['high', 'critical']);

interface Advisory { readonly id: string; readonly pkg: string; readonly severity: string; readonly title: string }

/** Every high/critical advisory `npm audit` reports in `dir`. npm exits 1 when it finds any — stdout still holds the JSON. */
function advisories(dir: string): Advisory[] {
  let out: string;
  try {
    out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? '');
    if (!out.trim()) throw err;
  }
  const report = JSON.parse(out) as { vulnerabilities?: Record<string, { via: unknown[] }> };
  const found = new Map<string, Advisory>();
  for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via) {
      if (typeof via !== 'object' || via === null) continue; // a name: the advisory is listed under that package
      const a = via as { url?: string; severity?: string; title?: string };
      if (!a.url || !GATE.has(a.severity ?? '')) continue;
      const id = a.url.split('/').pop()!;
      found.set(id, { id, pkg, severity: a.severity!, title: a.title ?? '' });
    }
  }
  return [...found.values()];
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push('.');
const today = new Date().toISOString().slice(0, 10);
const seen = new Set<string>();
let failures = 0;
for (const dir of dirs) {
  for (const a of advisories(dir)) {
    seen.add(a.id);
    const allowed = ALLOW[a.id];
    if (allowed && allowed.pkg === a.pkg) console.log(`allowed  ${dir}: ${a.severity} ${a.pkg} ${a.id} — ${allowed.reason}`);
    else { failures++; console.error(`FAIL     ${dir}: ${a.severity} ${a.pkg} ${a.id} ${a.title}`); }
  }
}
for (const [id, a] of Object.entries(ALLOW)) {
  if (a.reviewBy < today) { failures++; console.error(`FAIL     allowlist: ${id} (${a.pkg}) passed its review date ${a.reviewBy} — re-review or remove it`); }
  if (!seen.has(id)) { failures++; console.error(`FAIL     allowlist: ${id} (${a.pkg}) no longer appears in any audit — remove it`); }
}
console.log(failures ? `\n${failures} audit failure(s)` : `\nAudit gate passed: no high/critical advisory outside the allowlist (${seen.size} allowed).`);
process.exitCode = failures ? 1 : 0;
