// Import, composer, captures and input tables: the calls and the reply shapes.
// Contracts carry inputs only, so each reply is narrowed here by hand to what
// its handler returns (src/ipc/datasetImport.ts, datasetCompose.ts,
// captureDataset.ts, input.ts). Every figure in a reply — a row count, a
// total — is the server's; the screens only format it.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';
import type { GridColumn } from '../../ui/DataGrid/DataGrid';

export type Cell = string | number | null;
export type ColType = GridColumn['type'];

/** A parse as the composer receives it (src/data/parse.ts ParseResult + the stage handle). */
export interface ParsePreview {
  columns: GridColumn[];
  rows: Cell[][];
  rowCount: number;
  warnings: string[];
  sheetNames?: string[];
  stagedId?: string;
}

export type ParseReply =
  | { ok: true; canceled?: boolean; fileName?: string; sourceKind?: string; preview: ParsePreview }
  | { ok: false; error: string };

export const parseUpload = async (fileToken: string, sheetName?: string) =>
  (await rpc('dataset:pickAndParse', { fileToken, ...(sheetName ? { sheetName } : {}) })) as ParseReply;

export const parsePaste = async (text: string) => (await rpc('dataset:parsePaste', { text })) as ParseReply;

// ── Composer ──────────────────────────────────────────────────────────────

export type ComposeInput = RpcInput<'dataset:composeSave'>;
export type TableRef = ComposeInput['base'];
export type JoinRef = ComposeInput['joins'][number];

export type PreviewReply =
  | { ok: true; columns: GridColumn[]; rows: Cell[][]; total: number; sampled: boolean; warnings: string[] }
  | { ok: false; error: string };

export const composePreview = async (input: RpcInput<'dataset:composePreview'>) =>
  (await rpc('dataset:composePreview', input)) as PreviewReply;

export type SaveReply =
  | { ok: true; dataset: { id: string; name: string; rowCount: number }; warnings: string[] }
  | { ok: false; canceled?: boolean; error: string };

export const composeSave = async (input: ComposeInput) => (await rpc('dataset:composeSave', input)) as SaveReply;

// ── Captures ──────────────────────────────────────────────────────────────

/**
 * A capture drafted for the composer, or why not (a typed model error:
 * src/ai/analyze.ts). A refusal that carries `captureId` stored the capture —
 * only its table is missing, and its page still opens.
 */
export type DraftReply =
  | { ok: true; captureId: string; title: string; columns: GridColumn[]; rows: Cell[][]; warnings: string[]; unsure: boolean }
  | { ok: false; errorType: string; message: string; detail?: string; captureId?: string };
export type DraftOk = Extract<DraftReply, { ok: true }>;

export const draftCapture = async (input: RpcInput<'captureDataset:draft'>) => (await rpc('captureDataset:draft', input)) as DraftReply;

/**
 * One stored capture for its page (src/app/captureUpload.ts CaptureView). The
 * narration and follow-ups are the model's words; the headline's figures, the
 * metric lines and the chart data are the server's — the page only lays them out.
 */
export interface CaptureView {
  ok: true;
  id: string;
  title: string;
  createdAt: string;
  datasetId: string | null;
  hasImage: boolean;
  analysis: string;
  headline: { text: string; bold?: boolean }[] | null;
  metrics: { id: string; title: string; lines: string[] }[];
  chart: { labels: string[]; series: { name: string; values: (number | null)[] }[] };
  chartTypes: string[];
  followups: string[];
  table: { columns: GridColumn[]; rows: Cell[][]; warnings: string[] } | null;
  unsure: boolean;
}

/** `captureId` undefined: nothing is asked (the dock, off a capture's page). */
export function useCapture(projectId: string, captureId: string | undefined) {
  return useQuery({
    queryKey: ['captureDataset:get', projectId, captureId],
    queryFn: captureId === undefined ? skipToken : async () => (await rpc('captureDataset:get', { projectId, captureId })) as CaptureView | { ok: false; error: string },
  });
}

/** The screenshot as a PNG data URL, or null when the capture has none. It never changes once stored. */
export function useCaptureImage(projectId: string, captureId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['captureDataset:image', projectId, captureId],
    queryFn: async () => ((await rpc('captureDataset:image', { projectId, captureId })) as { ok: boolean; dataUrl?: string }).dataUrl ?? null,
    enabled,
    staleTime: Infinity,
  });
}

export interface CaptureSummary {
  id: string;
  title: string;
  updatedAt: string;
  datasetId: string | null;
  thumb: string | null;
  hasImage: boolean;
}

export function useCaptures(projectId: string | undefined) {
  return useQuery({
    queryKey: ['captureDataset:list', projectId],
    queryFn: projectId === undefined ? skipToken : async () => (await rpc('captureDataset:list', { projectId })) as CaptureSummary[],
  });
}

// ── Input tables ──────────────────────────────────────────────────────────

export type InputColumn = RpcInput<'input:create'>['columns'][number];

export interface Issue {
  r: number;
  c: number;
  severity: 'fail' | 'warn';
  kind: string;
  message?: string;
}

/** What input:load / input:save / input:setColumns return (src/data/inputTable/store.ts TableView). */
export interface TableView {
  ok: true;
  id: string;
  name: string;
  columns: InputColumn[];
  rows: Cell[][];
  cap: number;
  steps: number;
  lookupNames: Record<string, string>;
  check: { issues: Issue[]; notes: string[]; failCells: number; warnCells: number };
}
export type TableReply = TableView | { ok: false; error: string };

export interface LookupChoice {
  id: string;
  name: string;
  columns: GridColumn[];
}

export function useLookupChoices(projectId: string, selfId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['input:lookups', projectId, selfId],
    queryFn: enabled
      ? async () => {
          const r = (await rpc('input:lookups', { projectId, ...(selfId ? { id: selfId } : {}) })) as
            | { ok: true; datasets: LookupChoice[] }
            | { ok: false; error: string };
          if (!r.ok) throw new Error(r.error);
          return r.datasets;
        }
      : skipToken,
  });
}
