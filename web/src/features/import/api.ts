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

export type ModelStatus = { ready: true; provider: string } | { ready: false; reason: 'no_model' | 'not_allowed' };

export function useModelStatus(enabled = true) {
  return useQuery({
    queryKey: ['captureDataset:status'],
    queryFn: enabled ? async () => (await rpc('captureDataset:status')) as ModelStatus : skipToken,
  });
}

/** A capture drafted for the composer, or why not (a typed model error: src/ai/analyze.ts). */
export type DraftReply =
  | { ok: true; captureId: string; title: string; columns: GridColumn[]; rows: Cell[][]; warnings: string[]; unsure: boolean }
  | { ok: false; errorType: string; message: string; detail?: string };

export const draftCapture = async (input: RpcInput<'captureDataset:draft'>) => (await rpc('captureDataset:draft', input)) as DraftReply;

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
