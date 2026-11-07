// Reading an uploaded dbt file (semantic layer part 7, f1; docs/semantic-layer/07-portability.md D10). UNTRUSTED.
//
// The file is told by its content, never its name: JSON whose top level holds `semantic_models` and `metrics` (a
// list in semantic_manifest.json, an object keyed by unique id in manifest.json). It is refused, with a sentence:
// - past 32 MiB (checked before a byte is read) or past the value budget (./jsonBudget.ts, counted before it is
//   parsed): a full manifest.json holds the whole project, the semantic manifest only what is imported;
// - when it is not JSON, or not that shape; or when it defines more than one dry run reads.
// JSON.parse makes own properties only, and the translator (./dbtImport.ts) reads them by name with Object.hasOwn.

import * as fsp from 'fs/promises';
import { JsonTooComplex, parseBounded } from './jsonBudget';
import { dbtNotAManifest, dbtTooMany, dbtUseSemanticManifest } from './modelFileMessages';

const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_DBT_MODELS = 500; // datasetMap's own limit
export const MAX_DBT_METRICS = 2_000; // each one goes through the editor's checks in the dry run

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nodes = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : null);

/** The parsed JSON of a dbt upload at `file` (a local path), or the sentence refusing it. */
export async function readDbtUpload(file: string): Promise<{ json: unknown } | { error: string }> {
  if ((await fsp.stat(file)).size > MAX_BYTES) return { error: dbtUseSemanticManifest() };
  let json: unknown;
  try {
    const bytes = await fsp.readFile(file);
    json = await parseBounded(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes); // a UTF-8 BOM, as looksLikeJson reads past it
  } catch (err) {
    if (err instanceof JsonTooComplex) return { error: dbtUseSemanticManifest() };
    if (err instanceof SyntaxError) return { error: dbtNotAManifest() };
    throw err;
  }
  const models = isObj(json) && Object.hasOwn(json, 'semantic_models') ? nodes(json.semantic_models) : null;
  const metrics = isObj(json) && Object.hasOwn(json, 'metrics') ? nodes(json.metrics) : null;
  if (!models || !metrics) return { error: dbtNotAManifest() };
  if (models.length > MAX_DBT_MODELS || metrics.length > MAX_DBT_METRICS) return { error: dbtTooMany() };
  return { json };
}

/** Whether an upload's first byte that is not white space opens a JSON object: a zip starts `PK`, never `{`. */
export async function looksLikeJson(file: string): Promise<boolean> {
  const fh = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(512), 0, 512, 0);
    const head = buffer.subarray(0, bytesRead).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
    return head.startsWith('{');
  } finally {
    await fh.close();
  }
}
