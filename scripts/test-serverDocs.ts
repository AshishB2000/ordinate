// docs/server/configuration.md names every environment variable the server
// reads — and nothing else (T7.3).
//
// The reference is the code, read as text:
//
//   src/server/env.ts   every `src.NAME` and `required(src, 'NAME', …)` —
//                       the startup parse, so the operator-facing set
//   src/**/*.ts         every `process.env.NAME` / `process.env['NAME']`, plus
//                       the names behind the two dynamic reads listed in
//                       DYNAMIC (a new dynamic read fails this suite until it
//                       is listed). NOT_SERVER names the reads a server never
//                       reaches (src/app/paths.ts reads ORDINATE_LOCAL_DIR only
//                       outside server mode, for plain-Node self-checks).
//
// The documented set is every table row of configuration.md whose first cell
// is a back-ticked UPPER_CASE name. Variables read by libraries rather than by
// Ordinate (the AWS credential chain's AWS_ACCESS_KEY_ID, …) are listed there
// as prose, outside the tables, on purpose.
//
// Fails when a variable the code reads is missing from the tables, when a
// table names a variable no code reads, when a row lacks its five cells
// (name, purpose, default, required when, secret yes/no), or when a JSON
// example in docs/server/ does not parse or its ECS task definition names an
// unknown variable. A negative control runs the same audit over sabotaged
// inputs and must see each break.
//
//   npm run build:ts && node scripts/test-serverDocs.js

import * as fs from 'fs';
import * as path from 'path';

import { finish, ok } from './selfcheck';

const REPO = path.resolve(__dirname, '..');
const DOCS = path.join(REPO, 'docs', 'server');
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** Dynamic `process.env[expr]` sites and the names they read (each must appear in its file as a literal). */
const DYNAMIC: Readonly<Record<string, readonly string[]>> = {
  'src/connectors/saasHttp.ts': ['ORDINATE_SAAS_FIXTURE_BASE'],
  'src/server/secrets/rotate.ts': ['ORDINATE_MASTER_KEY_OLD', 'ORDINATE_MASTER_KEY_NEW'],
};

/** Read only outside server mode, so not server configuration: file → names. */
const NOT_SERVER: Readonly<Record<string, readonly string[]>> = {
  'src/app/paths.ts': ['ORDINATE_LOCAL_DIR'],
};

/** Read by libraries (DuckDB's AWS credential chain, Node), documented outside the tables. */
const LIBRARY = new Set([
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_PROFILE', 'NODE_EXTRA_CA_CERTS',
]);

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      srcFiles(rel, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

interface Audit {
  /** Read by the code, absent from the tables. */
  missing: string[];
  /** In the tables, read by no code. */
  unknown: string[];
  /** Dynamic reads not in DYNAMIC, or DYNAMIC names absent from their file. */
  dynamic: string[];
  /** Rows that are not `| name | purpose | default | required when | yes/no |`. */
  badRows: string[];
  envTsCount: number;
}

/** The whole check as a pure function of the texts, so the negative control can sabotage them. */
function audit(envTs: string, files: ReadonlyMap<string, string>, doc: string): Audit {
  const fromEnvTs = new Set<string>();
  for (const m of envTs.matchAll(/\bsrc\.([A-Z][A-Z0-9_]*)\b/g)) fromEnvTs.add(m[1]);
  for (const m of envTs.matchAll(/required\(src, '([A-Z][A-Z0-9_]*)'/g)) fromEnvTs.add(m[1]);
  const dynamic: string[] = [];
  // The one generic read in env.ts is required()'s `src[name]`; any other is a name this regex cannot see.
  if ((envTs.match(/\bsrc\[/g) ?? []).length !== 1) dynamic.push('src/server/env.ts: a new src[…] read');

  const read = new Set(fromEnvTs);
  for (const [file, text] of files) {
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\b/g)) if (!NOT_SERVER[file]?.includes(m[1])) read.add(m[1]);
    for (const m of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) read.add(m[1]);
    if (/process\.env\[(?!['"])/.test(text)) {
      const names = DYNAMIC[file];
      if (!names) dynamic.push(`${file}: process.env[…] with a computed name`);
      else {
        for (const n of names) {
          if (text.includes(`'${n}'`)) read.add(n);
          else dynamic.push(`${file}: ${n} not found`);
        }
      }
    }
  }

  const documented = new Set<string>();
  const badRows: string[] = [];
  for (const line of doc.split('\n')) {
    const m = /^\|\s*`([A-Z][A-Z0-9_]*)`/.exec(line);
    if (!m) continue;
    documented.add(m[1]);
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 5 || !/^(yes|no)\b/.test(cells[4]) || cells.slice(1, 4).some((c) => c === '')) badRows.push(m[1]);
  }
  return {
    missing: [...read].filter((n) => !documented.has(n)).sort(),
    unknown: [...documented].filter((n) => !read.has(n)).sort(),
    dynamic,
    badRows,
    envTsCount: fromEnvTs.size,
  };
}

const envTs = read('src/server/env.ts');
const files = new Map(srcFiles('src').map((f) => [f, read(f)] as const));
const doc = read('docs/server/configuration.md');

const a = audit(envTs, files, doc);
// A regex that stopped matching would pass vacuously: pin a floor and three anchors (one via required()).
ok(`env.ts parse finds its variables (${a.envTsCount})`, a.envTsCount >= 38, a.envTsCount);
const anchors = audit(envTs, files, '');
ok('anchors seen: DATABASE_URL, OIDC_ISSUER (required()), SSRF_ALLOW (process.env)', ['DATABASE_URL', 'OIDC_ISSUER', 'SSRF_ALLOW'].every((n) => anchors.missing.includes(n)));
ok('every variable the code reads is in configuration.md', a.missing.length === 0, a.missing.join(', '));
ok('configuration.md names no variable the code does not read', a.unknown.length === 0, a.unknown.join(', '));
ok('every dynamic process.env read is listed in DYNAMIC', a.dynamic.length === 0, a.dynamic.join('; '));
ok('every row has name | purpose | default | required when | secret yes/no', a.badRows.length === 0, a.badRows.join(', '));
ok('library-read variables stay out of the tables', [...LIBRARY].every((n) => !new RegExp(`^\\|\\s*\`${n}\``, 'm').test(doc)));

// JSON examples (the ECS task definition) parse, and name only real variables.
const known = new Set([...audit(envTs, files, '').missing, ...LIBRARY]);
let blocks = 0;
for (const f of fs.readdirSync(DOCS).filter((n) => n.endsWith('.md'))) {
  const text = fs.readFileSync(path.join(DOCS, f), 'utf8');
  for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    blocks++;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(m[1]);
    } catch (err) {
      ok(`${f}: JSON example parses`, false, (err as Error).message);
      continue;
    }
    const defs = (parsed as { containerDefinitions?: Array<{ environment?: Array<{ name: string }>; secrets?: Array<{ name: string }> }> }).containerDefinitions;
    if (!defs) continue;
    const names = defs.flatMap((d) => [...(d.environment ?? []), ...(d.secrets ?? [])].map((e) => e.name));
    const bad = names.filter((n) => !known.has(n));
    ok(`${f}: task definition names ${names.length} real variables`, names.length > 0 && bad.length === 0, bad.join(', '));
  }
}
ok(`docs/server has JSON examples (${blocks})`, blocks > 0);

// ── Negative control: each sabotage must be seen ────────────────────────────
const firstRow = /^\|\s*`ORDINATE_MASTER_KEY`.*\n/m;
ok('control: a dropped row is reported missing', audit(envTs, files, doc.replace(firstRow, '')).missing.includes('ORDINATE_MASTER_KEY'));
ok('control: an invented row is reported unknown', audit(envTs, files, `${doc}\n| \`ORDINATE_NOT_A_VAR\` | x | x | x | no |\n`).unknown.includes('ORDINATE_NOT_A_VAR'));
ok('control: a new env.ts read is reported missing', audit(envTs.replace('src.LOG_LEVEL', 'src.LOG_LEVEL ?? src.ORDINATE_NEW_KNOB'), files, doc).missing.includes('ORDINATE_NEW_KNOB'));
ok('control: a new process.env read is reported missing', audit(envTs, new Map([...files, ['src/x.ts', 'process.env.ORDINATE_X']]), doc).missing.includes('ORDINATE_X'));
ok('control: an unlisted dynamic read is reported', audit(envTs, new Map([...files, ['src/y.ts', 'process.env[name]']]), doc).dynamic.length === 1);
ok('control: a row without its secret cell is reported', audit(envTs, files, doc.replace(/^(\|\s*`PORT`.*)\|\s*(yes|no)[^|]*\|\s*$/m, '$1|')).badRows.includes('PORT'));

finish();
