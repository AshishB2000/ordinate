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
import type { ParsedColumn } from '../data/parse';

/** Larger than any screenshot a provider accepts; the upload cap still applies first. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** A list thumbnail is drawn by the browser (≤ 360 px wide); anything bigger is not one. */
export const MAX_THUMB_CHARS = 150_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Raster formats only: an SVG data URL can carry script.
const THUMB_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

type Fail = { ok: false; errorType: string; message: string; detail?: string };

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

/** The composer's draft of a stored capture (thread.json), or a refusal. */
// ponytail: the thread is the model-shaped envelope history.ts stores — any.
export function draftOf(thread: any): CaptureDraft | Fail {
  const result = thread && thread.result;
  const draft = buildDraft(result && result.extractedTable);
  if (!draft.columns.length) {
    return { ok: false, errorType: 'no_table', message: 'The model found no table in that screenshot to turn into a dataset.' };
  }
  const notes = result && typeof result.extractionNotes === 'string' ? result.extractionNotes.trim() : '';
  const conf = result && result.extractionConfidence;
  return {
    ok: true,
    captureId: String(thread.id),
    title: String((result && result.title) || thread.title || 'Captured data'),
    columns: draft.columns,
    rows: draft.rows,
    warnings: draft.warnings,
    unsure: conf === 'low' || conf === 'medium' || !!notes,
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
