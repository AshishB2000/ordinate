// What the fingerprint job reads and writes (docs/assistant/00-design.md "Scale rules", PR 7c): which items need a
// fingerprint, the vectors it makes, and how far an org is covered. MAIN PROCESS.
//
// An ITEM is one of the Assistant's search (0027: a dataset, a column, a metric, a term, a source table) or a verified
// question (0026, `verified:<id>`). Its TEXT is what a person reads, joined in SQL from the `text` its index rows
// store (0030), so finding what changed is one query and reads no record: ITEM_TEXT below, whose reference is
// ../app/assistantSearchRank itemText (a verified question's: the question as written). A row of
// assistant_search_vectors (0029) is fresh when its `text_hash` is the sha256 of that text and its `model` the org's;
// anything else is sent again, unless the provider refused that very text alone MAX_ATTEMPTS times in the last day
// (assistant_search_vector_failures, 0030). Retired items and those with no text get none. Values never: the index
// holds names and descriptions only.

import type { PoolClient } from 'pg';
import { inOrg } from './db/inOrg';
import { TEXT_MAX } from '../app/assistantSearchRank';
import type { VectorPlace } from './vectorStore';

/** A fingerprint model as its rows name it. */
export const modelKey = (pick: { provider: string; model: string }): string => `${pick.provider}:${pick.model}`;

/** A text refused alone this many times is skipped… */
export const MAX_ATTEMPTS = 3;
/** …until its last refusal is this old: then it is tried once more. */
const SKIP_FOR = `interval '1 day'`;

/**
 * Every item of the org (or of project `$2`) and its text: its parts' `text`, base first, joined by " — ", after its
 * dataset's name and " · " for a column or a metric; a verified question as written. `$1` org, `$2` a project id or
 * null for all of them.
 */
const ITEM_TEXT = `
  SELECT x.project_id, x.item, CASE WHEN x.body IS NULL THEN '' ELSE left(concat_ws(' · ', n.on_name, x.body), ${TEXT_MAX}) END AS text
  FROM (
    SELECT p.project_id, p.item, min(p.kind) FILTER (WHERE p.base) AS kind, min(p.dataset_id) FILTER (WHERE p.base) AS dataset_id,
      string_agg(p.text, ' — ' ORDER BY p.base DESC, p.path, p.grp, p.ord) FILTER (WHERE p.text <> '') AS body
    FROM assistant_search p WHERE p.org_id = $1 AND ($2::uuid IS NULL OR p.project_id = $2::uuid)
    GROUP BY p.project_id, p.item HAVING bool_or(p.base) AND NOT bool_or(p.retired)) x
  LEFT JOIN LATERAL (
    SELECT NULLIF(min(d.name), '') AS on_name FROM assistant_search d
    WHERE x.kind IN ('column', 'metric') AND d.org_id = $1 AND d.project_id = x.project_id AND d.item = 'dataset:' || x.dataset_id AND d.base) n ON true
  UNION ALL
  SELECT k.project_id, 'verified:' || k.id, k.text
  FROM verified_keys k WHERE k.org_id = $1 AND ($2::uuid IS NULL OR k.project_id = $2::uuid) AND k.ord = 0`;
const HASHED = `SELECT project_id, item, text, encode(sha256(convert_to(text, 'UTF8')), 'hex') AS hash FROM (${ITEM_TEXT}) i WHERE text <> ''`;

export interface Stale { item: string; text: string; hash: string }

const tx = <T>(fn: (c: PoolClient, org: string) => Promise<T>): Promise<T> => inOrg(fn);

/** The org's projects with an item, a question or a fingerprint. */
export const projectsOf = (): Promise<string[]> => tx(async (c, org) => (await c.query(
  `SELECT project_id::text AS p FROM assistant_search WHERE org_id = $1 UNION SELECT project_id::text FROM verified_keys WHERE org_id = $1
   UNION SELECT project_id::text FROM assistant_search_vectors WHERE org_id = $1 ORDER BY 1`, [org])).rows.map((r: { p: string }) => r.p));

/** Up to `limit` items of `projectId` with no fresh fingerprint of `model`, by key; a text being skipped left out. */
export const staleTexts = (projectId: string, model: string, limit: number): Promise<Stale[]> => tx(async (c, org) => (await c.query(
  `SELECT t.item, t.text, t.hash FROM (${HASHED}) t
   LEFT JOIN assistant_search_vectors v ON v.org_id = $1 AND v.project_id = $2::uuid AND v.item = t.item AND v.model = $3
   WHERE v.text_hash IS DISTINCT FROM t.hash
     AND NOT EXISTS (SELECT 1 FROM assistant_search_vector_failures f WHERE f.org_id = $1 AND f.project_id = $2::uuid AND f.item = t.item
       AND f.model = $3 AND f.text_hash = t.hash AND f.attempts >= ${MAX_ATTEMPTS} AND f.failed_at > now() - ${SKIP_FOR})
   ORDER BY t.item LIMIT $4`, [org, projectId, model, limit])).rows as Stale[]);

/** The provider refused each of `rows` alone: one attempt more each. How many have now reached MAX_ATTEMPTS (skipped). */
export const refused = (projectId: string, model: string, rows: readonly Stale[], code: string): Promise<number> => tx(async (c, org) => {
  if (!rows.length) return 0;
  const r = await c.query(
    `INSERT INTO assistant_search_vector_failures AS f (org_id, project_id, item, model, text_hash, attempts, code)
     SELECT $1, $2::uuid, u.item, $3, u.hash, 1, $6 FROM unnest($4::text[], $5::text[]) AS u(item, hash)
     ON CONFLICT (org_id, project_id, item, model, text_hash) DO UPDATE SET attempts = f.attempts + 1, code = EXCLUDED.code, failed_at = now()
     RETURNING f.attempts`,
    [org, projectId, model, rows.map((x) => x.item), rows.map((x) => x.hash), code],
  );
  return (r.rows as Array<{ attempts: number }>).filter((x) => x.attempts === MAX_ATTEMPTS).length;
});

/** Stores (or replaces) fingerprints of `model`, one per item: its text's hash and vector (`literal`, ./vectorStore vectorLiteral). */
export const saveVectors = (projectId: string, model: string, place: VectorPlace, rows: ReadonlyArray<{ item: string; hash: string; literal: string }>): Promise<void> =>
  tx(async (c, org) => {
    if (!rows.length) return;
    await c.query(
      `INSERT INTO assistant_search_vectors (org_id, project_id, item, model, text_hash, embedding)
       SELECT $1, $2::uuid, u.item, $3, u.hash, u.v::${place.type} FROM unnest($4::text[], $5::text[], $6::text[]) AS u(item, hash, v)
       ON CONFLICT (org_id, project_id, item, model) DO UPDATE SET text_hash = EXCLUDED.text_hash, embedding = EXCLUDED.embedding, updated_at = now()`,
      [org, projectId, model, rows.map((r) => r.item), rows.map((r) => r.hash), rows.map((r) => r.literal)],
    );
  });

/**
 * Once `model` covers `projectId`: every fingerprint of another model goes, and those of items no longer there; so do
 * the refusals of another model, or of a text no item has now. The count of fingerprints removed.
 */
export const tidy = (projectId: string, model: string): Promise<number> => tx(async (c, org) => {
  const gone = (await c.query(
    `WITH i AS MATERIALIZED (SELECT item FROM (${ITEM_TEXT}) x)
     DELETE FROM assistant_search_vectors v WHERE v.org_id = $1 AND v.project_id = $2::uuid AND (v.model <> $3 OR NOT EXISTS (SELECT 1 FROM i WHERE i.item = v.item))`,
    [org, projectId, model])).rowCount ?? 0;
  await c.query(
    `WITH i AS MATERIALIZED (SELECT item, hash FROM (${HASHED}) x)
     DELETE FROM assistant_search_vector_failures f WHERE f.org_id = $1 AND f.project_id = $2::uuid
       AND (f.model <> $3 OR NOT EXISTS (SELECT 1 FROM i WHERE i.item = f.item AND i.hash = f.text_hash))`,
    [org, projectId, model]);
  return gone;
});

/** Does `projectId` hold any fingerprint of `model`? */
export const hasVectors = (projectId: string, model: string): Promise<boolean> => tx(async (c, org) => (await c.query(
  'SELECT EXISTS (SELECT 1 FROM assistant_search_vectors WHERE org_id = $1 AND project_id = $2::uuid AND model = $3) AS on', [org, projectId, model])).rows[0].on === true);

/** How many of the org's items have a text, and how many of those a fresh fingerprint of `model` (Admin → AI). */
export const coverage = (model: string): Promise<{ items: number; fingerprinted: number }> => tx(async (c, org) => (await c.query(
  `SELECT count(*)::int AS items, count(v.item)::int AS fingerprinted FROM (${HASHED}) t
   LEFT JOIN assistant_search_vectors v ON v.org_id = $1 AND v.project_id = t.project_id AND v.item = t.item AND v.model = $3 AND v.text_hash = t.hash`,
  [org, null, model])).rows[0] as { items: number; fingerprinted: number });
