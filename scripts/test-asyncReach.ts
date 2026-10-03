// Self-check for T4.2 — no SYNCHRONOUS DuckDB call is reachable from an RPC
// handler, so a request can never park the server's event loop.
//
// "Reachable", concretely:
//   ROOTS  = src/server/*.ts (app.ts's registerHandlers included) + every
//            src/ipc/*.ts (each file's register(deps) is a set of handlers).
//   EDGES  = every relative `import … from`, `export … from`, `import '…'` and
//            `require('…')` in a module's CODE (comments and strings blanked),
//            lazy requires inside functions included. `import type` /
//            `export type` are erased by tsc and are not edges.
//   A module is reachable when a chain of edges leads to it from a root.
//   `new Worker(file)` is NOT an edge: a worker thread has its own module
//   registry and its own DuckDB bridge, and the sync guard exempts it.
//
// "Synchronous DuckDB call": in a reachable module's code, a call of the sync
// bridge — `<ns>.query(` / `<ns>.exec(` where `<ns>` is that module's binding of
// ./engine/duckdb (namespace import, or a const require), a named `query`/`exec`
// import from it called by its local name — or `runOrdered(` (the sync twin
// residentQuery had until T4.2). duckdb.ts itself, which DEFINES the sync API,
// is the one module exempt from the scan.
//
// WORKER-ONLY modules (allowed to stay sync, never imported by src/): the
// list below is asserted unreachable, so one being imported by a request path
// fails here too. A negative control proves the scanner sees each sync form.
//
//   npm run build:ts && node scripts/test-asyncReach.js

import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DUCKDB = path.join(SRC, 'engine', 'duckdb.ts');

/** Run in a worker thread or only by tests/benches — sync is allowed there, and none may be reachable. */
const WORKER_ONLY = [
  'src/engine/computeWorker.ts', // compute pool thread (computePool spawns it by path)
  'src/engine/duckdbWorker.ts', // the bridge's own DuckDB thread
  'src/engine/duckdbSidecarChild.ts', // the unadopted sidecar's child process
  'src/engine/parquetStoreSync.ts', // sync Parquet read/write for tests, benches and fixtures
];

/** Blank comments and string/template contents (keeping `${…}` code), so only code is scanned. */
export function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const tpl: number[] = []; // brace depth at each open `${`
  let depth = 0;
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === '/' && /(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn)\s*$/.test(out.slice(-40))) {
      // A regex literal (a `/` where an operand starts): skip it whole, so a
      // quote inside one (`/"/g`) is not read as the start of a string.
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        j++;
      }
      out += '/' + blank(src.slice(i + 1, j)) + (src[j] ?? '');
      i = j + 1;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += c + blank(src.slice(i + 1, j)) + (src[j] ?? '');
      i = j + 1;
    } else if (c === '`' || (c === '}' && tpl.length && tpl[tpl.length - 1] === depth)) {
      // a template literal, or the rest of one after a `${…}` closes
      if (c === '}') tpl.pop();
      let j = i + 1;
      while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
      out += c + blank(src.slice(i + 1, j));
      if (src[j] === '$') {
        out += '${';
        tpl.push(depth);
        i = j + 2;
      } else {
        out += src[j] ?? '';
        i = j + 1;
      }
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c;
      i++;
    }
  }
  return out;
}

/** Relative specifiers this module loads at runtime (type-only imports excluded). */
export function edgesOf(code: string, raw: string): string[] {
  // Specifiers live in strings, which codeOnly blanked — read them from the
  // raw text at the same offsets (blanking preserves length).
  const out: string[] = [];
  // The clause may span lines but never another import/export statement, so a
  // `from` is always paired with its own keyword (and its own `type`).
  const re = /\b(import|export)\s+(type\s+)?(?:(?!\n\s*(?:import|export)\b)[^;])*?\bfrom\s+(['"])|\bimport\s+(['"])|\brequire\(\s*(['"])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[2]) continue; // `import type … from` / `export type … from`
    const q = m.index + m[0].length - 1;
    const end = raw.indexOf(raw[q], q + 1);
    const spec = raw.slice(q + 1, end);
    if (spec.startsWith('.')) out.push(spec);
  }
  return out;
}

function resolve(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const f of [base + '.ts', path.join(base, 'index.ts')]) if (fs.existsSync(f)) return f;
  return null;
}

/** Every sync-bridge call site in one module's code: `line: text`. */
export function syncSites(code: string, raw: string): string[] {
  const ns = new Set<string>();
  const fns = new Set<string>();
  const imp = /\bimport\s+(?!type\b)([^;]*?)\s+from\s+(['"])([^'"]*)\2/g;
  const req = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=]*)?=\s*require\(\s*(['"])([^'"]*)\2\s*\)/g;
  const isDuck = (spec: string): boolean => /(^|\/)duckdb(\.js)?$/.test(spec);
  let m: RegExpExecArray | null;
  while ((m = imp.exec(raw))) {
    if (!isDuck(m[3])) continue;
    const clause = m[1];
    const star = /\*\s+as\s+(\w+)/.exec(clause);
    if (star) ns.add(star[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(',')) {
        const p = part.trim().replace(/^type\s+/, '');
        const [orig, local] = p.split(/\s+as\s+/).map((s) => s.trim());
        if (orig === 'query' || orig === 'exec') fns.add(local || orig);
      }
    }
  }
  while ((m = req.exec(raw))) if (isDuck(m[3])) ns.add(m[1]);
  const pats: RegExp[] = [/(?<![\w.$])runOrdered\(/g];
  for (const a of ns) pats.push(new RegExp(`(?<![\\w.$])${a}\\.(query|exec)\\(`, 'g'));
  for (const f of fns) pats.push(new RegExp(`(?<![\\w.$])${f}\\(`, 'g'));
  const sites: string[] = [];
  for (const re of pats) {
    while ((m = re.exec(code))) {
      const line = code.slice(0, m.index).split('\n').length;
      sites.push(`${line}: ${raw.split('\n')[line - 1].trim()}`);
    }
  }
  return sites;
}

function rel(f: string): string {
  return path.relative(ROOT, f).split(path.sep).join('/');
}

// ── The walk ─────────────────────────────────────────────────────────────────
const roots: string[] = [];
for (const dir of ['server', 'ipc']) {
  for (const f of fs.readdirSync(path.join(SRC, dir))) {
    if (f.endsWith('.ts') && !f.endsWith('.d.ts')) roots.push(path.join(SRC, dir, f));
  }
}
const seen = new Map<string, string>(); // module → the module that first reached it
const queue = roots.slice();
for (const r of roots) seen.set(r, '(root)');
const unresolved: string[] = [];
while (queue.length) {
  const file = queue.shift() as string;
  const raw = fs.readFileSync(file, 'utf8');
  for (const spec of edgesOf(codeOnly(raw), raw)) {
    const to = resolve(file, spec);
    if (!to) {
      if (!fs.existsSync(path.resolve(path.dirname(file), spec))) unresolved.push(`${rel(file)} → ${spec}`);
      continue;
    }
    if (!seen.has(to)) {
      seen.set(to, file);
      queue.push(to);
    }
  }
}

ok(`walked ${roots.length} roots → ${seen.size} reachable modules`, roots.length > 50 && seen.size > roots.length);
ok('the walk reaches the resident layer (pivot, stats, anomalies, join, pipelineDuck)',
  ['pivotResident', 'statsResident', 'anomaliesResident', 'joinResident', 'pipelineDuck', 'parquetStore']
    .every((m) => seen.has(path.join(SRC, 'engine', m + '.ts'))));
ok('every relative edge resolves to a source file', unresolved.length === 0, unresolved.join('\n'));

const offenders: string[] = [];
for (const file of seen.keys()) {
  if (file === DUCKDB) continue;
  const raw = fs.readFileSync(file, 'utf8');
  for (const s of syncSites(codeOnly(raw), raw)) offenders.push(`${rel(file)}:${s}`);
}
ok('ZERO synchronous DuckDB calls reachable from an RPC handler', offenders.length === 0, '\n  ' + offenders.join('\n  '));

for (const w of WORKER_ONLY) {
  const abs = path.join(ROOT, w);
  ok(`worker-only ${w} exists and is NOT reachable from a handler`, fs.existsSync(abs) && !seen.has(abs),
    seen.has(abs) ? `reached via ${rel(seen.get(abs) as string)}` : 'missing');
}
ok('residentSync.ts is gone', !fs.existsSync(path.join(SRC, 'engine', 'residentSync.ts')));

// ── Negative controls: the scanner sees every sync form it claims to ────────
const probe = (text: string): number => syncSites(codeOnly(text), text).length;
ok('control: a namespace import calling query( is caught', probe("import * as duck from '../engine/duckdb';\nduck.query('x');") === 1);
ok('control: exec( through a const require is caught', probe("const db = require('./duckdb');\ndb.exec('x');") === 1);
ok('control: a renamed named import is caught', probe("import { query as q } from './duckdb';\nq('x');") === 1);
ok('control: runOrdered( is caught', probe("runOrdered(p, f, []);") === 1);
ok('control: queryAsync / execAsync / comments / strings are NOT', probe(
  "import * as duck from './duckdb';\nawait duck.queryAsync('a'); await duck.execAsync('b');\n// duck.query(x)\nconst s = 'duck.exec(y)';\n/* runOrdered( */",
) === 0);
ok('control: a quote inside a regex literal does not hide the next line', probe(
  "import * as duck from './duckdb';\nconst q = `\"${p.replace(/\"/g, '\"\"')}\"`; const r = a / b / c;\nduck.query(q);",
) === 1);
ok('control: an edge inside a template ${} is still code', edgesOf(codeOnly('`${require(\'./a\')}`'), '`${require(\'./a\')}`').join() === './a');
ok('control: `import type` is not an edge', edgesOf(codeOnly("import type { X } from './t';"), "import type { X } from './t';").length === 0);
const syncFile = fs.readFileSync(path.join(SRC, 'engine', 'parquetStoreSync.ts'), 'utf8');
ok('control: the real sync module (parquetStoreSync) IS flagged by the scanner', syncSites(codeOnly(syncFile), syncFile).length >= 4);

finish();
