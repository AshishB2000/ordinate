// pg_trgm's similarity() in JS — PURE. The reference the spelling query (../server/assistantSearchIndex speltPage)
// is held to with Object.is (scripts/test-nameSpelling.ts), and what answers where Postgres has no pg_trgm, or none
// that agrees with this (../server/nameTrigrams: a probe at first use), or there is no database.
//
// pg_trgm (contrib/pg_trgm/trgm_op.c; checked on PG 17, the probe checks any other) in a UTF-8 database with a UTF-8 ctype:
//   words    maximal runs of alphanumerics (iswalnum: the Unicode Alphabetic property, or a decimal digit); anything
//            else separates them
//   case     each word lower-cased one code point at a time (towlower: Unicode's simple mapping, 1 to 1)
//   pad      two spaces before each word and one after; its trigrams are its runs of three code points
//   bytes    a trigram of three one-byte characters is those three bytes; any other is the first three bytes in memory
//            (little-endian, as x86-64 and arm64 are) of the legacy CRC-32 of its UTF-8, so two can collide and count once
//   score    the SET of each string's trigrams, A and B: |A ∩ B| / |A ∪ B| in float4; 0 when either is empty
// A string is first cleaned as every stored name is (./searchMatch clean): no NUL, a lone surrogate as U+FFFD.

import { clean } from './searchMatch';

/** pg_trgm.similarity_threshold's default, the `%` operator's: below it, a name is not near. */
export const MIN_SIMILARITY = 0.3;

const WORD = /[\p{Alphabetic}\p{Nd}]+/gu;

// pg_crc.h's legacy CRC-32: zlib's table (Ethernet's polynomial, reflected) run by the "normal" Sarwate step, high byte
// first. It matches no standard CRC; show_trgm's hex trigrams are the check (scripts/test-nameSpelling.ts).
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function legacyCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = (TABLE[((crc >>> 24) ^ b) & 0xff] ^ (crc << 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

/** A trigram as pg_trgm stores it: three bytes, as one number. */
function code(t: string): number {
  const b = Buffer.from(t, 'utf8');
  if (b.length === 3) return (b[0] << 16) | (b[1] << 8) | b[2];
  const crc = legacyCrc(b);
  return ((crc & 0xff) << 16) | (((crc >>> 8) & 0xff) << 8) | ((crc >>> 16) & 0xff);
}

/** towlower: one code point in, one out (U+0130's full lowercase is two; its simple one is the first). */
const lower = (c: string): string => String.fromCodePoint(c.toLowerCase().codePointAt(0) as number);

/** The set of `s`'s trigrams, as pg_trgm's show_trgm makes them (each as its three bytes). */
export function trigrams(s: string): Set<number> {
  const out = new Set<number>();
  for (const [w] of clean(s).matchAll(WORD)) {
    const cs = [' ', ' ', ...Array.from(w, lower), ' '];
    for (let i = 0; i + 2 < cs.length; i++) out.add(code(cs[i] + cs[i + 1] + cs[i + 2]));
  }
  return out;
}

/** pg_trgm's similarity(a, b), the float4 it returns, exactly. */
export function similarityOf(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return Math.fround(n / (a.size + b.size - n)); // a double rounded to float4 is the float4 quotient: 53 ≥ 2 × 24 + 2
}

export const similarity = (a: string, b: string): number => similarityOf(trigrams(a), trigrams(b));
