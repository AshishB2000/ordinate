// A screenshot UPLOADED to the server becomes a capture — the server's form of
// the desktop's capture loop (its ingestCapture), which grabbed pixels
// off a screen the server does not have. SERVER.
//
//   upload (POST /api/files) → the model reads the image HERE, on the server,
//   through the org's own API-key provider (src/ai/byok.ts: allowed providers,
//   no local CLI) → the same capture RECORD the desktop writes (history.ts:
//   thread.json + crop.png, project-scoped, its narration seeded as a dock
//   conversation) → the extracted table drafted through the ordinary finalize
//   (src/data/captureDataset.ts) for the composer.
//
// The model only EXTRACTS: every type, coercion and warning comes from the
// app's own parse path. Nothing here computes a figure.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as history from './history';
import { persistableResult, seedCaptureConversation } from './captureRecord';
import { analyze } from '../ai/analyze';
import { buildDraft } from '../data/captureDataset';
import { deriveChartData } from '../formula/calc';
import { withChartFigures } from '../analysis/chartShapes';
import { figureAsk } from '../analysis/figureAsk';
import type { ParsedColumn } from '../data/parse';

/** Larger than any screenshot a provider accepts; the upload cap still applies first. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** A list thumbnail is drawn by the browser (≤ 360 px wide); anything bigger is not one. */
export const MAX_THUMB_CHARS = 150_000;
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Raster formats only: an SVG data URL can carry script.
const THUMB_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** `captureId` is set when the capture WAS stored and only its table is missing (its page still opens). */
type Fail = { ok: false; errorType: string; message: string; detail?: string; captureId?: string };

type Table = { columns: ParsedColumn[]; rows: (string | number | null)[][]; warnings: string[] };

/**
 * A stored capture as its own page shows it. The narration and the follow-up
 * questions are the model's words; the headline, the metrics and the chart
 * data are the app's (src/ai/headline.ts, src/formula/calc.ts). No server path.
 */
export interface CaptureView {
  ok: true;
  id: string;
  title: string;
  createdAt: string;
  datasetId: string | null;
  hasImage: boolean;
  analysis: string;
  /** Figures are the bold segments; null when no headline could be verified. */
  headline: { text: string; bold?: boolean }[] | null;
  metrics: { id: string; title: string; lines: string[] }[];
  chart: { labels: string[]; series: { name: string; values: (number | null)[] }[] };
  /** The chart ids the model judged a fit, in its order. */
  chartTypes: string[];
  followups: string[];
  /** The extracted table as the composer opens it; null when the screenshot carried none. */
  table: Table | null;
  unsure: boolean;
}

export interface CaptureDraft {
  ok: true;
  captureId: string;
  title: string;
  columns: ParsedColumn[];
  rows: (string | number | null)[][];
  warnings: string[];
  /** The model's own caution about what it read — said once, where the review happens. */
  unsure: boolean;
}

/** A browser-made thumbnail, or null when it is not a small raster data URL. */
export function cleanThumb(thumb: unknown): string | null {
  return typeof thumb === 'string' && thumb.length <= MAX_THUMB_CHARS && THUMB_RE.test(thumb) ? thumb : null;
}

// ponytail: `result` is the model-shaped envelope history.ts stores — any.
function tableOf(result: any): Table | null {
  const draft = buildDraft(result && result.extractedTable);
  return draft.columns.length ? { columns: draft.columns, rows: draft.rows, warnings: draft.warnings } : null;
}

/** The model's own caution about what it read: a low or medium confidence, or a note. */
function unsureOf(result: any): boolean {
  const notes = result && typeof result.extractionNotes === 'string' ? result.extractionNotes.trim() : '';
  const conf = result && result.extractionConfidence;
  return conf === 'low' || conf === 'medium' || !!notes;
}

const titleOf = (thread: any): string => String((thread.result && thread.result.title) || thread.title || 'Captured data');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

/** The composer's draft of a stored capture (thread.json), or a refusal. */
// ponytail: the thread is the model-shaped envelope history.ts stores — any.
export function draftOf(thread: any): CaptureDraft | Fail {
  const table = tableOf(thread && thread.result);
  if (!table) {
    return { ok: false, errorType: 'no_table', message: 'The model found no table in that screenshot to turn into a dataset.', captureId: String(thread.id) };
  }
  return { ok: true, captureId: String(thread.id), title: titleOf(thread), ...table, unsure: unsureOf(thread.result) };
}

/** The chart ids the model judged a fit, in its order. */
const chartTypesOf = (result: any): string[] => (Array.isArray(result.visualizations) ? strings(result.visualizations.map((v: any) => v && v.type)) : []);

/** A stored capture for its own page. */
// ponytail: thread envelope — any. A record an older build wrote may lack any field, so each is narrowed.
export function viewOf(thread: any): CaptureView {
  const result = thread.result || {};
  const metrics = result.metrics && Array.isArray(result.metrics.selected) ? result.metrics.selected : [];
  const segments = result.headlineProse && Array.isArray(result.headlineProse.segments) ? result.headlineProse.segments : [];
  return {
    ok: true,
    id: String(thread.id),
    title: titleOf(thread),
    createdAt: String(thread.createdAt || thread.updatedAt || ''),
    datasetId: typeof thread.datasetId === 'string' ? thread.datasetId : null,
    hasImage: !!thread.cropPath,
    analysis: typeof result.analysis === 'string' ? result.analysis.trim() : '',
    headline: segments.length
      ? segments.map((s: any) => ({ text: String(s.text), ...(s.bold ? { bold: true } : {}) }))
      : null,
    metrics: metrics.map((m: any) => ({ id: String(m.id), title: String(m.title), lines: strings(m.lines) })),
    // Derived again from the table, not read back: a record an older build
    // wrote may carry chart data from before the app derived it.
    // …with the figures each suggested type draws over it (analysis/chartShapes).
    chart: chartTypesOf(result).reduce((d, t) => withChartFigures(d, figureAsk(t)), deriveChartData(result.extractedTable, result.columnRoles, result.dataShape)),
    chartTypes: chartTypesOf(result),
    followups: strings(result.followups),
    table: tableOf(result),
    unsure: unsureOf(result),
  };
}

/** Analyze an uploaded PNG, store it as a capture of `projectId`, and draft its table. */
export async function captureFromUpload(projectId: string, file: string, thumb: unknown): Promise<CaptureDraft | Fail> {
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_IMAGE_BYTES) return { ok: false, errorType: 'bad_image', message: 'That image is too large to read (over 20 MB).' };
  const buf = await fs.promises.readFile(file);
  // The provider adapters send the image as PNG (src/ai/analyze.ts); the browser converts before uploading.
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, errorType: 'bad_image', message: 'That file is not a PNG image.' };
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');

  // ponytail: analyze() returns the model's loose envelope (or a typed error) — any.
  const result: any = await analyze(dataUrl);
  if (!result || !result.ok) return result || { ok: false, errorType: 'unknown', message: 'Something went wrong. Try again.' };

  const id = randomUUID();
  const at = new Date().toISOString();
  const cropPath = await history.saveCrop(id, dataUrl);
  const thread = {
    id,
    projectId,
    title: result.title || 'Analysis',
    createdAt: at,
    updatedAt: at,
    cropPath,
    copilotThreadId: await seedCaptureConversation(projectId, result),
    datasetId: null,
    thumb: cleanThumb(thumb),
    messages: result._messages,
    result: persistableResult(result),
    turns: [],
  };
  await history.saveThread(thread);
  return draftOf(thread);
}

/** A capture of `projectId`, or null — another project's capture is not found. */
// ponytail: thread envelope — any.
export async function loadOwn(projectId: string, captureId: string): Promise<any> {
  const thread = await history.loadThread(captureId);
  return thread && thread.projectId === projectId ? thread : null;
}
