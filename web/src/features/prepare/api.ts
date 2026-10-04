// The Prepare area's server calls (src/api/prepare.ts). Contracts carry inputs
// only, so each reply is narrowed here by hand, mirrored from the handlers:
// src/ipc/preparePower.ts (prepareState, stepPreview), src/ipc/datasets.ts
// (the step channels, through src/ipc/stepReply.ts), src/ipc/formula.ts,
// src/ipc/text.ts and src/ipc/geoAnalysis.ts.
//
// Every figure in these replies was computed by the server. Nothing here (or
// in the screens) counts, sums or divides one — they format and lay out.

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';

export type ColType = 'text' | 'number' | 'date';
export interface Column {
  name: string;
  type: ColType;
}
/** One pipeline step, as stored (src/data/transforms.ts TransformStep). */
export type Step = { type: string } & Record<string, unknown>;
export interface StepCount {
  before: number;
  after: number;
}

export interface PrepareState {
  id: string;
  name: string;
  rowCount: number;
  columns: Column[];
  steps: Step[];
  /** Rows into / out of each step, index-aligned with `steps`; null when unknown. */
  stepCounts: StepCount[] | null;
  updatedAt: string;
}

type Fail = { ok: false; error: string; cancelled?: boolean; notReady?: boolean };

/** What every step-mutating channel answers on the server (no rows, no origin). */
export type StepReply =
  | {
      ok: true;
      dataset: Pick<PrepareState, 'id' | 'name' | 'columns' | 'rowCount' | 'steps' | 'updatedAt'> & { stepCounts?: StepCount[] };
      preview: { columns: Column[]; rowCount: number; warnings: string[]; stepCounts?: StepCount[] };
    }
  | Fail;

export const prepareKey = (projectId: string, datasetId: string) => ['prepare:get', projectId, datasetId] as const;

export function usePrepare(projectId: string | undefined, datasetId: string | undefined) {
  return useQuery({
    queryKey: ['prepare:get', projectId, datasetId],
    queryFn:
      projectId === undefined || datasetId === undefined
        ? skipToken
        : async () => (await rpc('prepare:get', { projectId, datasetId })) as PrepareState | null,
  });
}

export type Mutation =
  | { kind: 'add'; step: Step }
  | { kind: 'update'; index: number; step: Step }
  | { kind: 'remove'; index: number }
  | { kind: 'reorder'; order: number[] }
  | { kind: 'set'; steps: Step[] }
  | { kind: 'text'; index: number; step: Step }
  | { kind: 'spatial'; index: number; step: Step };

/** Sends one pipeline edit; the server recomputes from the source and answers with the new shape. */
export async function mutate(projectId: string, datasetId: string, m: Mutation): Promise<StepReply> {
  const at = { projectId, datasetId };
  let res: unknown;
  switch (m.kind) {
    case 'add':
      res = await rpc('dataset:addStep', { ...at, step: m.step });
      break;
    case 'update':
      res = await rpc('dataset:updateStep', { ...at, index: m.index, step: m.step });
      break;
    case 'remove':
      res = await rpc('dataset:removeStep', { ...at, index: m.index });
      break;
    case 'reorder':
      res = await rpc('dataset:reorderSteps', { ...at, order: m.order });
      break;
    case 'set':
      res = await rpc('dataset:setSteps', { ...at, steps: m.steps });
      break;
    case 'text':
      res = await rpc('text:commitStep', { ...at, index: m.index, step: m.step });
      break;
    case 'spatial':
      res = await rpc('geo:saveSpatialStep', { ...at, index: m.index, step: m.step });
      break;
  }
  return (res ?? { ok: false, error: 'No reply from the server.' }) as StepReply;
}

/** Applies a successful reply to the cached state and refreshes what it changed elsewhere. */
export function useApplyReply(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return (r: Extract<StepReply, { ok: true }>) => {
    const d = r.dataset;
    qc.setQueryData<PrepareState | null>(prepareKey(projectId, datasetId), (old) => ({
      id: d.id,
      name: d.name,
      rowCount: r.preview.rowCount,
      columns: r.preview.columns,
      steps: d.steps,
      stepCounts: r.preview.stepCounts ?? d.stepCounts ?? old?.stepCounts ?? null,
      updatedAt: d.updatedAt,
    }));
    void qc.invalidateQueries({ queryKey: ['dataset:columns', projectId, datasetId] });
    void qc.invalidateQueries({ queryKey: ['dataset:list', projectId] });
  };
}

// ── The Assistant (structure only; nothing is applied until the user does) ──

export type SuggestReply = ({ ok: true; steps: Step[] } | Fail) & { notReady?: boolean };
export type CalcReply = ({ ok: true; name: string; expression: string; warning?: string } | Fail) & { notReady?: boolean };

export const suggestSteps = async (projectId: string, datasetId: string) =>
  (await rpc('dataset:suggestSteps', { projectId, datasetId })) as SuggestReply;
export const suggestCalc = async (projectId: string, datasetId: string) =>
  (await rpc('dataset:suggestCalcField', { projectId, datasetId })) as CalcReply;

// ── The formula editor ──

export interface Tok {
  kind: string;
  value: string | number;
  start: number;
  end: number;
}
export type FValue = string | number | boolean | null;
export interface FormulaCheck {
  tokens: Tok[];
  ok: boolean;
  error?: string;
  at?: { start: number; end: number };
  refs: string[];
  unknownRefs: { name: string; didYouMean?: string }[];
  resultType: 'number' | 'string' | 'date' | 'logical' | null;
  sample: { columns: string[]; rows: { inputs: FValue[]; result: FValue }[]; lodColumns?: number; note?: string };
}
export interface FunctionDoc {
  name: string;
  category: string;
  signature: string;
  summary: string;
  example: string;
  insert?: string;
  kind?: 'keyword' | 'recipe';
}

export function useFunctionDocs() {
  return useQuery({
    queryKey: ['formula:functions'],
    queryFn: async () => (await rpc('formula:functions')) as FunctionDoc[],
    staleTime: Infinity,
  });
}

export const checkFormula = async (projectId: string, datasetId: string, expression: string) =>
  (await rpc('formula:check', { projectId, datasetId, expression })) as FormulaCheck;

// ── Previews: what an unsaved step would do, counted by the server ──

export interface PowerPreview {
  ok: boolean;
  error?: string;
  before?: number;
  after?: number;
  warnings?: string[];
  lookup?: { matched: number; total: number; dupes: number; ratePct: number };
  parseDate?: { parsed: number; failed: number; empty: number; filled: number; samples: string[] };
  union?: { otherRows: number; unmatched: string[]; missing: string[] };
}
export interface TextPreview {
  ok: boolean;
  error?: string;
  before: number;
  after: number;
  warnings: string[];
  sampled: boolean;
  total: number;
  sampleRows: number;
  columns?: string[];
  rows?: (string | number | null)[][];
  sentiment?: {
    scored: number;
    empty: number;
    mean: number | null;
    negative: number;
    neutral: number;
    positive: number;
    examples: { text: string; score: number }[];
  };
  categories?: { category: string; count: number; isDefault: boolean; pct: number; barPct: number }[];
}
export interface SpatialPreview {
  ok: boolean;
  error?: string;
  stats?: { total: number; matched: number; noCoords: number; regions: number; top: { name: string; count: number }[]; pct: number; outside: number };
}

export const previewPower = async (projectId: string, datasetId: string, index: number, step: Step) =>
  (await rpc('prepare:stepPreview', { projectId, datasetId, index, step })) as PowerPreview;
export const previewText = async (projectId: string, datasetId: string, index: number, step: Step) =>
  (await rpc('text:preview', { projectId, datasetId, index, step })) as TextPreview;
export const previewSpatial = async (projectId: string, datasetId: string, index: number, step: Step) =>
  (await rpc('geo:spatialPreview', { projectId, datasetId, index, step })) as SpatialPreview;

export interface BoundarySet {
  id: string;
  name: string;
  featureCount: number;
  properties: { key: string; unique?: boolean }[];
}
export function useBoundarySources(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['geo:boundarySources', projectId],
    queryFn: enabled ? async () => (await rpc('geo:boundarySources', { projectId })) as { ok: boolean; custom: BoundarySet[] } : skipToken,
  });
}

export interface Relationship {
  from: { datasetId: string; column: string };
  to: { datasetId: string; column: string };
}
export const listRelationships = async (projectId: string) =>
  (await rpc('relationship:list', { projectId })) as { ok: boolean; relationships?: Relationship[] };

// ── The text profile (the column profile's Text section) ──

export interface Bar {
  term: string;
  count: number;
  pct: number;
  barPct: number;
}
export interface TextProfileData {
  sampled: number;
  cap: number;
  avgLength: number;
  medianLength: number;
  eligible: boolean;
  lang: 'en' | 'es' | 'fr' | 'de';
  detected: 'en' | 'es' | 'fr' | 'de';
  topTerms: Bar[];
  topBigrams: Bar[];
  sentiment: { mean: number; bands: { label: string; count: number }[] } | null;
  mood?: 'positive' | 'neutral' | 'negative';
}
export function useTextProfile(projectId: string, datasetId: string, column: string | null, lang: TextProfileData['lang'] | undefined) {
  return useQuery({
    queryKey: ['text:profile', projectId, datasetId, column, lang],
    queryFn:
      column === null
        ? skipToken
        : async () => {
            const r = (await rpc('text:profile', { projectId, datasetId, column, ...(lang ? { lang } : {}) })) as
              | { ok: true; profile: TextProfileData | null }
              | Fail;
            if (!r.ok) throw new Error(r.error || 'Could not read this column’s text.');
            return r.profile;
          },
  });
}
