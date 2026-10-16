// Signed embedding (docs/embed/00-design.md) — the server calls. Replies
// mirror src/ipc/embed.ts, narrowed by hand: contracts carry inputs only.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';

export interface EmbedStatus {
  /** The server has a database and a master key, so it can keep a secret. */
  canStore: boolean;
  enabled: boolean;
  origins: string[];
  secretSet: boolean;
  /** The org id a token's header names (`kid`). */
  org: string;
}

export interface EmbedSettings extends EmbedStatus {
  maxOrigins: number;
  maxTtlHours: number;
  maxLockColumns: number;
}

export interface LockColumn {
  name: string;
  type: 'text' | 'number' | 'date';
  /** How many of the dashboard's tiles read a dataset that has it. */
  tiles: number;
}

export type ColumnsReply = { ok: true; tiles: number; columns: LockColumn[] } | { ok: false; error: string; republish?: boolean };

export type Lock = { column: string; values: string[] };
export type Hide = 'title' | 'filters';

/** A refusal's sentence, or the fallback. */
export const reason = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export const useEmbedSettings = () => useQuery({ queryKey: ['embed:settings'], queryFn: async () => (await rpc('embed:settings')) as EmbedSettings });
export const useEmbedStatus = () => useQuery({ queryKey: ['embed:status'], queryFn: async () => (await rpc('embed:status')) as EmbedStatus });

export function useEmbedColumns(projectId: string, siteId: string, dashboardId: string | null) {
  return useQuery({
    queryKey: ['embed:columns', projectId, siteId, dashboardId],
    enabled: !!dashboardId,
    queryFn: async () => (await rpc('embed:columns', { projectId, siteId, dashboardId: dashboardId as string })) as ColumnsReply,
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: ['embed:settings'] }), client.invalidateQueries({ queryKey: ['embed:status'] })]);
}

export function useEmbedSave() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (input: RpcInput<'embed:save'>) => (await rpc('embed:save', input)) as { ok: true } | { ok: false; error: string },
    onSuccess: async (r) => { if (r.ok) await refresh(); },
  });
}

export function useEmbedRotate() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async () => (await rpc('embed:rotate')) as { ok: true; secret: string } | { ok: false; error: string },
    onSuccess: async () => { await refresh(); },
  });
}

export function useEmbedPreview() {
  return useMutation({
    mutationFn: async (input: RpcInput<'embed:preview'>) => (await rpc('embed:preview', input)) as { ok: true; url: string; expiresAt: string } | { ok: false; error: string },
  });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The server's rule (src/server/embed/settings.ts normalizeOrigin), so the
 * field can say so as it is typed: https, or http on a loopback name; no path.
 * The server decides — this only spares a round trip.
 */
export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 255 || s.includes('*')) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (s.replace(/\/$/, '').toLowerCase() !== u.origin.toLowerCase()) return null;
  if (u.protocol === 'https:') return u.origin;
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname) ? u.origin : null;
}

/** The token's `params` claim for `locks`: a number column's numeric values as numbers. */
export function paramsOf(locks: readonly Lock[], columns: readonly LockColumn[]): Record<string, (string | number)[]> {
  const out: Record<string, (string | number)[]> = {};
  for (const l of locks) {
    const values = l.values.map((v) => v.trim()).filter(Boolean);
    if (!l.column || !values.length) continue;
    const num = columns.find((c) => c.name === l.column)?.type === 'number';
    out[l.column] = values.map((v) => (num && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v));
  }
  return out;
}
