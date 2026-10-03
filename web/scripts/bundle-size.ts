// Fails the build when the INITIAL JavaScript — what index.html loads before
// any route runs: the entry module plus anything it modulepreloads — is over
// the budget, gzipped. Feature routes are lazy chunks and do not count.
//
//   npm --prefix web run size          (after `npm --prefix web run build`)
//   node web/scripts/bundle-size.ts 100   a lower limit in KB (the negative control)
//
// KB = 1000 bytes, as Vite's own build report prints them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT_KB = Number(process.argv[2] ?? 300);
if (!(LIMIT_KB > 0)) throw new Error(`limit must be a positive number of KB, got ${process.argv[2]}`);
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
const tags = html.match(/<(script|link)\b[^>]*>/g) ?? [];
const files = tags.flatMap((tag) => {
  const module = /^<script\b/.test(tag) && /\btype="module"/.test(tag);
  const preload = /^<link\b/.test(tag) && /\brel="modulepreload"/.test(tag);
  const url = /\b(?:src|href)="\/?([^"]+)"/.exec(tag)?.[1];
  return (module || preload) && url ? [url] : [];
});
if (files.length === 0) throw new Error('no module script in dist/index.html — is it a Vite build?');

let total = 0;
for (const f of files) {
  const gz = gzipSync(readFileSync(path.join(DIST, f))).length;
  total += gz;
  console.log(`${(gz / 1000).toFixed(2).padStart(8)} KB gzip  ${f}`);
}
const verdict = total <= LIMIT_KB * 1000 ? 'ok' : 'OVER BUDGET';
console.log(`${(total / 1000).toFixed(2).padStart(8)} KB gzip  initial JS — limit ${LIMIT_KB} KB: ${verdict}`);
if (verdict !== 'ok') process.exit(1);
