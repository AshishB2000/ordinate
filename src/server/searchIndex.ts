// The ⌘K name search's index at rest (0022_search_index.sql) — the SQL only. What goes in, in what order, and
// when a source is rebuilt is src/ipc/search.ts. Every statement runs in inOrg (forced RLS) and names its org
// anyway. Everything here returns null, or does nothing, without a database.

import { inOrg, orgDb } from './db/inOrg';

/** One row a search can return: a record (or a dashboard's saved view) by its name. */
export interface IndexEntry {
  kind: string;
  id: string;
  /** A saved view's dashboard id. */
  parentId?: string;
  name: string;
  /** The dim second line the palette shows. */
  sub: string;
}

/** The stamp each source was last built from, by source; null without a database. */
export async function storedStamps(projectId: string, sources: readonly string[]): Promise<Map<string, string> | null> {
  if (!orgDb()) return null;
  return inOrg(async (c, org) => {
    const r = await c.query('SELECT source, stamp FROM search_sources WHERE org_id = $1 AND project_id = $2 AND source = ANY($3::text[])', [org, projectId, sources]);
    return new Map(r.rows.map((x: { source: string; stamp: string }) => [x.source, x.stamp]));
  });
}

/**
 * Replace one source's rows and its stamp, in one transaction. The advisory lock makes two pods rebuilding the same
 * source take turns (else the second insert meets the first's keys). `stamp` is the one read BEFORE `entries` were
 * listed, so a save landing mid-build leaves an old stamp behind and the next search builds again.
 */
export async function replaceSource(projectId: string, source: string, srcOrd: number, stamp: string, entries: readonly IndexEntry[]): Promise<void> {
  if (!orgDb()) return;
  await inOrg(async (c, org) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`search:${org}:${projectId}:${source}`]);
    await c.query('DELETE FROM search_entries WHERE org_id = $1 AND project_id = $2 AND source = $3', [org, projectId, source]);
    if (entries.length) {
      await c.query(
        `INSERT INTO search_entries (org_id, project_id, source, ord, src_ord, kind, id, parent_id, name, name_lc, sub)
         SELECT $1, $2, $3, u.ord, $4, u.kind, u.id, u.parent_id, u.name, u.name_lc, u.sub
         FROM unnest($5::int[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[]) AS u(ord, kind, id, parent_id, name, name_lc, sub)`,
        [
          org, projectId, source, srcOrd,
          entries.map((_, i) => i), entries.map((e) => e.kind), entries.map((e) => e.id), entries.map((e) => e.parentId ?? null),
          entries.map((e) => e.name), entries.map((e) => e.name.toLowerCase()), entries.map((e) => e.sub),
        ],
      );
    }
    await c.query(
      `INSERT INTO search_sources (org_id, project_id, source, stamp) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, project_id, source) DO UPDATE SET stamp = EXCLUDED.stamp, built_at = now()`,
      [org, projectId, source, stamp],
    );
  });
}

/**
 * Entries whose name contains `needle` (already trimmed and lower-cased by JS), best first: exact, then prefix, then
 * contains (data/dataSearch.ts rankOf), each in source then list order — the JS path's order. Null without a database.
 */
// shortcut: strpos scans the project's rows (fine into the tens of thousands); add a pg_trgm GIN index past that.
export async function queryEntries(projectId: string, sources: readonly string[], needle: string, limit: number): Promise<IndexEntry[] | null> {
  if (!orgDb()) return null;
  return inOrg(async (c, org) => {
    const r = await c.query(
      `SELECT kind, id, parent_id, name, sub FROM search_entries
       WHERE org_id = $1 AND project_id = $2 AND source = ANY($3::text[]) AND strpos(name_lc, $4) > 0
       ORDER BY CASE WHEN name_lc = $4 THEN 0 WHEN strpos(name_lc, $4) = 1 THEN 1 ELSE 2 END, src_ord, ord
       LIMIT $5`,
      [org, projectId, sources, needle, limit],
    );
    return r.rows.map((x: { kind: string; id: string; parent_id: string | null; name: string; sub: string }) => ({
      kind: x.kind, id: x.id, ...(x.parent_id ? { parentId: x.parent_id } : {}), name: x.name, sub: x.sub,
    }));
  });
}

/** A deleted project's rows go with it: they hold its record names. */
export async function forgetProject(projectId: string): Promise<void> {
  if (!orgDb()) return;
  await inOrg(async (c, org) => {
    await c.query('DELETE FROM search_entries WHERE org_id = $1 AND project_id = $2', [org, projectId]);
    await c.query('DELETE FROM search_sources WHERE org_id = $1 AND project_id = $2', [org, projectId]);
  });
}
