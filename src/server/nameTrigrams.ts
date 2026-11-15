// Whether the spelling query can rank on pg_trgm here (0031_name_trigrams.sql): the extension in this database, and its
// similarity() Object.is-equal to the reference's (../app/trigram) on a probe of names. pg_trgm splits and lower-cases
// by the database's ctype: in a C-ctype database "é" is no letter, and the probe tells. Without either, the query
// reads the names the caller may find and the reference ranks them (./assistantSearchIndex speltPage).
//
// Cached per pod for STATUS_TTL_MS, by pool, as ./vectorStore: a fact about the database every org shares, holding no
// org's data. Nothing here creates the extension: that is the migration's, or the operator's.

import type { Pool } from 'pg';
import { orgDb } from './db/inOrg';
import { logger } from '../app/logger';
import { similarity } from '../app/trigram';

const STATUS_TTL_MS = 30_000;

/** pg_trgm's similarity function and `%` operator, schema-qualified (an operator may have put it off the search_path). */
export interface TrgmPlace { readonly similarity: string; readonly op: string }

/** Accents, ß, digits, Greek, Cyrillic, CJK, a combining mark, İ, punctuation: what a name holds and pg_trgm must split as the reference does. */
const PROBE: ReadonlyArray<readonly [string, string]> = [
  ['Ordrs', 'Orders'], ['Café crème', 'CAFE creme'], ['Straße', 'STRASSE'], ['Zürich 2024', 'zurich-2024'], ['ΟΔΟΣ', 'οδός'],
  ['Москва', 'МОСКВА'], ['東京都', '東京'], ['école', 'école'], ['İstanbul', 'istanbul'], ['٣٤٥ sales', 'sales_345'],
];

let cached: { pool: Pool; at: number; place: TrgmPlace | null } | null = null;
let warned = false;

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

async function read(pool: Pool): Promise<TrgmPlace | null> {
  const r = await pool.query<{ nspname: string }>(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'`);
  if (!r.rows.length) return null;
  const s = ident(r.rows[0].nspname);
  const place = { similarity: `${s}.similarity`, op: `OPERATOR(${s}.%)` };
  const got = await pool.query<{ s: number }>(`SELECT ${place.similarity}(a, b)::float8 AS s FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS u(a, b, n) ORDER BY n`, [PROBE.map((p) => p[0]), PROBE.map((p) => p[1])]);
  const differ = PROBE.filter(([a, b], i) => !Object.is(got.rows[i]?.s, similarity(a, b)));
  if (!differ.length) return place;
  if (!warned) {
    warned = true;
    logger.warn(`[assistant search] pg_trgm splits names unlike the app here (the database's ctype; ${differ.length} of ${PROBE.length} probes differ): spelling is ranked by the app`);
  }
  return null;
}

/** pg_trgm, when this database has it and it agrees with the reference, as of at most `maxAgeMs` ago; else null. */
export async function trgmPlace(maxAgeMs: number = STATUS_TTL_MS): Promise<TrgmPlace | null> {
  const pool = orgDb();
  if (!pool) return null;
  if (cached && cached.pool === pool && Date.now() - cached.at < maxAgeMs) return cached.place;
  const place = await read(pool);
  cached = { pool, at: Date.now(), place };
  return place;
}
