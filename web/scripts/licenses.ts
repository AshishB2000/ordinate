// The About page's licences: every PRODUCTION dependency the app ships — the
// web app's (web/package.json, bundled into the browser build) and the
// server's (package.json) — with everything they in turn depend on, as
// installed. Read at BUILD time (vite.config.ts writes the result as
// licenses.json next to index.html); no dependency, no network.
//
//   node web/scripts/licenses.ts   prints the count and the licence tally

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Licence {
  name: string;
  version: string;
  license: string;
  /** An https URL to the source, when the package names one. */
  url?: string;
  /** The package's own LICENSE / COPYING text, when it ships one. */
  text?: string;
}

export interface Licences {
  app: { name: string; version: string };
  generatedAt: string;
  packages: Licence[];
}

const MAX_TEXT = 64 * 1024;

interface Pkg {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: Array<string | { type?: string }>;
  repository?: string | { url?: string };
  homepage?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function read(file: string): Pkg | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Pkg;
  } catch {
    return null;
  }
}

/** Node's resolution: node_modules/<name> in `from`, then each parent. */
function resolveDir(name: string, from: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const cand = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(cand, 'package.json'))) return cand;
    if (path.dirname(dir) === dir) return null;
  }
}

function licenceOf(p: Pkg): string {
  const one = (l: string | { type?: string } | undefined) => (typeof l === 'string' ? l : l?.type ?? '');
  return one(p.license) || (p.licenses ?? []).map(one).filter(Boolean).join(' OR ') || 'UNKNOWN';
}

/** `git+https://github.com/x/y.git`, `github:x/y`, `x/y` → https://github.com/x/y. */
export function sourceUrl(p: Pick<Pkg, 'repository' | 'homepage'>): string | undefined {
  const raw = typeof p.repository === 'string' ? p.repository : p.repository?.url;
  if (raw) {
    const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
    if (short) return `https://github.com/${short[1]}`;
    const m = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?([^/]+)\/(.+?)(?:\.git)?(?:#.*)?$/.exec(raw) ?? /^git@([^:]+):(.+?)(?:\.git)?$/.exec(raw);
    if (m) return `https://${m[1]}/${m[2]}`;
  }
  return p.homepage && /^https:\/\//.test(p.homepage) ? p.homepage : undefined;
}

function licenceText(dir: string): string | undefined {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)([._-]|$)/i.test(f));
  if (!file) return undefined;
  try {
    return readFileSync(path.join(dir, file), 'utf8').slice(0, MAX_TEXT).trim();
  } catch {
    return undefined;
  }
}

/** Every production package reachable from the given package roots, deduplicated by name@version. */
export function collectLicences(roots: readonly string[], app: { name: string; version: string }): Licences {
  const seen = new Set<string>();
  const out = new Map<string, Licence>();
  const queue: Array<[string, string]> = [];
  const enqueue = (p: Pkg, from: string) => {
    for (const name of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) queue.push([name, from]);
  };
  for (const root of roots) {
    const p = read(path.join(root, 'package.json'));
    if (p) enqueue(p, root);
  }
  while (queue.length) {
    const [name, from] = queue.shift() as [string, string];
    const dir = resolveDir(name, from);
    if (!dir || seen.has(dir)) continue; // an optional dependency not installed on this platform
    seen.add(dir);
    const p = read(path.join(dir, 'package.json'));
    if (!p || !p.name) continue;
    const key = `${p.name}@${p.version ?? ''}`;
    if (!out.has(key)) out.set(key, { name: p.name, version: p.version ?? '', license: licenceOf(p), url: sourceUrl(p), text: licenceText(dir) });
    enqueue(p, dir);
  }
  const packages = [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
  return { app, generatedAt: new Date().toISOString(), packages };
}

/** The app's own: web/ and the repo root it sits in. */
export function appLicences(webDir: string): Licences {
  const rootDir = path.resolve(webDir, '..');
  const root = read(path.join(rootDir, 'package.json'));
  return collectLicences([webDir, rootDir], { name: 'Ordinate', version: root?.version ?? '' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const l = appLicences(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'));
  const tally = new Map<string, number>();
  for (const p of l.packages) tally.set(p.license, (tally.get(p.license) ?? 0) + 1);
  console.log(`${l.app.name} ${l.app.version}: ${l.packages.length} packages, ${l.packages.filter((p) => p.text).length} with a licence file`);
  console.log([...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
  console.log(`${Math.round(JSON.stringify(l).length / 1024)} KB as JSON`);
}
