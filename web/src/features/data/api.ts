// The Data section's calls (T2.3). Contracts carry inputs only, so each reply
// is narrowed here by hand to what its handler returns (src/ipc/datasets.ts,
// datasetViews.ts, quality.ts, catalog.ts, lineage.ts, relationships.ts,
// dataSearch.ts). Every figure in a reply — a percent, a bar length, a count —
// is the server's; the screens only format it.

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type Channel, type RpcArgs, type RpcInput } from '../../api/client';
import { toast } from '../../ui/Toast';

export type ColumnType = 'text' | 'number' | 'date';

/** src/data/datasetStats.ts ColumnSummary. */
export interface ColumnSummary {
  name: string;
  type: ColumnType;
  nonEmpty: number;
  min?: number;
  max?: number;
  mean?: number;
  distinct?: number;
  mostCommon?: { value: string; count: number } | null;
}

export interface QualityIssue {
  kind: string;
  column?: string;
  detail: string;
  severity: 'info' | 'warn';
}

export interface Stats {
  summaries: ColumnSummary[];
  issues: QualityIssue[];
  /** Each column's filled share, rounded by the server. */
  filledPct: number[];
}

/** src/data/datasetOrigin.ts SourceView — the redacted origin. */
export interface SourceView {
  kind: string;
  label: string;
  refreshable: boolean;
  /** A Live dataset, and how old a cached answer may be (L2.1). */
  live?: true;
  maxCacheAgeSec?: number;
  /** An extract whose connection offers Live (absent otherwise). */
  canGoLive?: true;
}

/** src/data/profileView.ts ColumnProfile. */
export interface Bar {
  label: string;
  value: number;
  pct: number;
}
export interface Profile {
  name: string;
  type: ColumnType;
  rowCount: number;
  filled: number | null;
  filledPct: number | null;
  empty: number | null;
  distinct: number | null;
  min: number | null;
  median: number | null;
  max: number | null;
  mostCommon: string | null;
  distribution: {
    kind: 'histogram' | 'bars';
    heading: 'distribution' | 'month' | 'top';
    bars: Bar[];
    of: number;
    total?: number;
    lo?: string;
    hi?: string;
  } | null;
}

export type RuleKind = 'not_null' | 'unique' | 'range' | 'regex' | 'in_set' | 'row_count' | 'references';
export interface Rule {
  id: string;
  kind: RuleKind;
  column?: string;
  args: Record<string, unknown>;
  severity: 'fail' | 'warn';
}
export type RuleDraft = Omit<Rule, 'id'> & { id?: string };
export interface RuleResult {
  ruleId: string;
  passed: boolean;
  failing: number;
  error?: string;
}
export interface Quality {
  rules: Rule[];
  latest: { at: string; results: RuleResult[] } | null;
  history: { at: string; failing: Record<string, number> }[];
}
export type Preview = { ok: true; passed: boolean; failing: number; error?: string } | { ok: false; error: string };

export interface TagChip {
  name: string;
  color: number;
}
export interface TagIndex {
  tags: (TagChip & { count: number })[];
  refs: Record<string, string[]>;
}
export interface CatalogRow {
  ref: string;
  kind: string;
  type: string;
  id: string;
  name: string;
  sub: string;
  description: string;
  tags: TagChip[];
  owner: string;
  updatedBy: string;
  updatedAt: string;
  usage: number;
  stale: boolean;
}
export interface CatalogList {
  rows: CatalogRow[];
  kinds: { kind: string; label: string; count: number }[];
}
export interface Doc {
  description: string;
  tags: TagChip[];
  owner: string;
  updatedBy: string;
  updatedAt: string;
}
export interface ColumnDoc {
  description?: string;
  displayName?: string;
  example?: string;
  sensitivity?: 'none' | 'personal' | 'financial';
  updatedBy?: string;
  updatedAt?: string;
}

export interface LineageNode {
  id: string;
  kind: string;
  name: string;
  sub: string;
  ref?: { type: string; id: string };
  col: number;
  row: number;
}
export interface Lineage {
  nodes: LineageNode[];
  edges: { from: string; to: string }[];
  focus: string;
  usedIn: Record<string, number>;
  columns: number;
  /** Records left of the focus — what it is built from. */
  upstream: number;
}

export interface Relationship {
  id: string;
  from: { datasetId: string; column: string };
  to: { datasetId: string; column: string };
  cardinality: 'many_to_one' | 'one_to_one';
  verified: { matched: number; unmatchedFrom: number };
  matchPct: number;
}
export interface KeyCandidate {
  from: string;
  to: string;
  name: number;
  typeMatch: boolean;
  rate: number | null;
  ratePct: number | null;
}
export interface Suggestion {
  candidates: KeyCandidate[];
  best: (KeyCandidate & { cardinality: Relationship['cardinality'] | null; stats: { toKeys: number; toKeyed: number } | null }) | null;
}

export interface DataHit {
  datasetId: string;
  datasetName: string;
  column: string;
  value: string;
  rows: number;
}

type Fail = { ok: false; error?: string };
/** A handler's `{ ok: false, error }` as a query error, so the screen's error state shows it. */
function okOr<T extends { ok: boolean }>(r: T | Fail, what: string): T {
  if (!r.ok) throw new Error((r as Fail).error || `${what} could not be read.`);
  return r as T;
}

const useRead = <T,>(key: readonly unknown[], fn: (() => Promise<T>) | null) =>
  useQuery({ queryKey: key, queryFn: fn ?? skipToken });

export const useStats = (projectId: string, datasetId: string) =>
  useRead(['dataset:stats', projectId, datasetId], async () =>
    okOr((await rpc('dataset:stats', { projectId, datasetId })) as ({ ok: true } & Stats) | Fail, 'The column statistics'));

export const useSource = (projectId: string, id: string) =>
  useRead(['dataset:source', projectId, id], async () => (await rpc('dataset:source', { projectId, id })) as SourceView | null);

export const useProfile = (projectId: string, datasetId: string, column: string | null) =>
  useRead(['dataset:profile', projectId, datasetId, column], column === null ? null : async () =>
    okOr((await rpc('dataset:profile', { projectId, datasetId, column })) as { ok: true; profile: Profile } | Fail, 'The column profile').profile);

export const useQualityRules = (projectId: string, datasetId: string) =>
  useRead(['quality:list', projectId, datasetId], async () =>
    okOr((await rpc('quality:list', { projectId, datasetId })) as ({ ok: true } & Quality) | Fail, 'The rules'));

export const useTags = (projectId: string) =>
  useRead(['catalog:tags', projectId], async () => (await rpc('catalog:tags', { projectId })) as { ok: true } & TagIndex);

export const useCatalog = (projectId: string) =>
  useRead(['catalog:list', projectId], async () =>
    okOr((await rpc('catalog:list', { projectId })) as ({ ok: true } & CatalogList) | Fail, 'The catalog'));

export const useColumnDocs = (projectId: string, datasetId: string) =>
  useRead(['catalog:columns', projectId, datasetId], async () =>
    ((await rpc('catalog:columns', { projectId, datasetId })) as { columns: Record<string, ColumnDoc> }).columns);

export type LineageType = RpcInput<'lineage:get'>['type'];
export const useLineage = (projectId: string, id: string, on = true, type: LineageType = 'dataset') =>
  useRead(['lineage:get', projectId, type, id], on ? async () => (await rpc('lineage:get', { projectId, type, id })) as Lineage | null : null);

export const useRelationships = (projectId: string) =>
  useRead(['relationship:list', projectId], async () =>
    okOr((await rpc('relationship:list', { projectId })) as { ok: true; relationships: Relationship[] } | Fail, 'The relationships').relationships);

export const useDataSearch = (projectId: string, term: string) =>
  useRead(['dataSearch:query', projectId, term], term.trim().length < 2 ? null : async () =>
    okOr((await rpc('dataSearch:query', { projectId, term: term.trim() })) as { ok: true; hits: DataHit[]; partial: string[] } | Fail, 'The search'));

type Cell = string | number | null;
type PageReply = { ok: true; rows: Cell[][]; total: number } | { ok: false; error: string };

/** A DataGrid source over the rows a stored rule fails (`quality:failingRows`). Memoize it. */
export function failingRowsSource(projectId: string, datasetId: string, ruleId: string, query: { search?: string; sortColumn?: string; sortDir?: 'asc' | 'desc' }) {
  return async (offset: number, limit: number): Promise<{ rows: Cell[][]; total: number }> => {
    const r = (await rpc('quality:failingRows', { projectId, datasetId, ruleId, offset, limit, ...query })) as PageReply;
    if (!r.ok) throw new Error(r.error || 'The failing rows could not be read.');
    return { rows: r.rows, total: r.total };
  };
}

/** One-off reads a dialog makes (no cache entry worth keeping). */
export const call = rpc;

type Reply = { ok?: boolean; error?: string };

/**
 * A write: calls `channel`, refreshes every query whose key starts with one of
 * `refresh` on success, and toasts a refusal (`ok: false`) or a failure. The
 * reply goes to `onDone` either way, so a dialog can keep its own error line.
 */
export function useWrite<C extends Channel, R extends Reply = Reply>(
  channel: C,
  refresh: readonly string[],
  opts: { onDone?: (reply: R) => void; quiet?: boolean } = {},
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: RpcInput<C>) => (await rpc(channel, ...([input] as RpcArgs<C>))) as R,
    onSuccess: (reply) => {
      for (const key of refresh) void client.invalidateQueries({ queryKey: [key] });
      if (reply && reply.ok === false && !opts.quiet) toast(reply.error || 'The change was refused.', { kind: 'error' });
      opts.onDone?.(reply);
    },
    onError: (err) => toast(`The change did not go through: ${err.message}`, { kind: 'error' }),
  });
}
