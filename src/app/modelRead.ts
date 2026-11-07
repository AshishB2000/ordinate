// Model files read back (semantic layer part 7, a2; docs/semantic-layer/07-portability.md D4, D5): an uploaded zip, or
// the same files inline (a4's MCP tool), into a1's shapes (./modelFormat.ts). The upload is UNTRUSTED.
//
// - The zip goes through the repo's reader with MODEL_POLICY: the layout's names only (no path can leave it), each
//   entry's cap, the entry count and the total, no encryption, no data descriptor. Inline files get the same checks.
// - Every JSON entry is counted before it is parsed, against ONE value budget for the whole upload (./jsonBudget.ts).
// - Each object goes through a whitelist reader: unknown keys are dropped, a wrong type or length makes it invalid.
//   Nested definitions and filter steps pass as they are: the editor's own sanitizers judge them at plan time.
//
// The whole upload is refused (a sentence) for a refused name or size, a missing or unreadable model.json, another
// format or a newer formatVersion. One bad object is an `invalid` item and the rest still reads.

import { z } from 'zod';
import { openZip, ZipRefused, type ZipReader } from './zipReader';
import { countJsonValuesAsync, MAX_JSON_VALUES } from './jsonBudget';
import { isValidId } from './ids';
import { MAX_GUIDE } from './tableDocs';
import { MAX_RELATIONSHIPS } from '../analysis/relationships';
import * as bundleMsg from './bundleMessages';
import * as msg from './modelFileMessages';
import {
  MODEL_FORMAT, MODEL_POLICY, MODEL_VERSION,
  type ModelDataset, type ModelManifest, type ModelMetric, type ModelRelationship, type ModelTerm,
} from './modelFormat';

export interface ParsedModel {
  manifest: ModelManifest;
  datasets: ModelDataset[];
  /** Dataset id → its guide, trimmed as the store trims it. */
  guides: Map<string, string>;
  metrics: ModelMetric[];
  terms: ModelTerm[];
  relationships: ModelRelationship[];
  /** `id`: the object's, when the file named a valid one. */
  invalid: Array<{ path: string; error: string; id?: string }>;
}

export type ModelRead = ParsedModel | { refused: string };

// The editor's own caps (src/api/catalog.ts, src/analysis/terms.ts, src/analysis/relationships.ts).
const Id = z.string().refine(isValidId);
const Obj = z.unknown().refine((v) => !!v && typeof v === 'object' && !Array.isArray(v)); // passed by reference: never copied key by key
const Steps = z.array(Obj).max(200);
const Field = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2_000).optional(),
  displayName: z.string().max(120).optional(),
  aliases: z.array(z.string().max(60)).max(8).optional(),
  example: z.string().max(200).optional(),
  sensitivity: z.enum(['personal', 'financial']).optional(),
  values: z.array(z.object({ value: z.string().min(1).max(256), label: z.string().max(120) })).max(500).optional(),
});
const Dataset = z.object({
  id: Id,
  name: z.string().min(1).max(500),
  base: z.string().max(64).optional(), // no base: no three-way check (the plan's call)
  description: z.string().max(2_000).optional(),
  role: z.enum(['fact', 'dimension']).optional(),
  key: z.string().max(256).optional(),
  grain: z.string().max(200).optional(),
  fields: z.array(Field).max(5_000).optional(),
  baseFilters: Steps.optional(),
});
const Metric = z.object({
  id: Id,
  name: z.string().min(1).max(200),
  dataset: Id,
  base: z.string().max(64).optional(), // no base: no three-way check (the plan's call)
  definition: Obj,
  filters: Steps.optional(),
  format: Obj,
  description: z.string().max(2_000).optional(),
  direction: z.enum(['up_good', 'down_good']).optional(),
  timeColumn: z.string().max(256).optional(),
  target: Obj.optional(),
});
const Term = z.object({
  id: Id,
  name: z.string().min(1).max(200),
  dataset: Id,
  base: z.string().max(64).optional(), // no base: no three-way check (the plan's call)
  aliases: z.array(z.string().max(60)).max(8).optional(),
  description: z.string().max(500).optional(),
  filters: Steps,
});
const End = z.object({ dataset: Id, column: z.string().min(1).max(500) });
const Relationship = z.object({
  id: Id,
  base: z.string().max(64).optional(), // no base: no three-way check (the plan's call)
  from: End,
  to: End,
  cardinality: z.enum(['many_to_one', 'one_to_one']),
  label: z.string().max(60).optional(),
});
const Manifest = z.object({
  format: z.string(),
  formatVersion: z.number().int().min(1),
  appVersion: z.string().max(64),
  project: z.object({ name: z.string().max(500) }),
  calendar: z.unknown(), // for reference only: an import never reads it
});

class TooManyValues extends Error {}

/** A hostile name, shown in a sentence: no control or format characters, cut short (as ./zipReader shows one). */
const shown = (name: string): string => name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 120);
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Path → bytes, already through the whitelist, the caps and the total. */
async function parseEntries(entries: ReadonlyMap<string, Uint8Array>): Promise<ModelRead> {
  let values = 0;
  const json = async (bytes: Uint8Array): Promise<unknown> => {
    if ((values += await countJsonValuesAsync(bytes)) > MAX_JSON_VALUES) throw new TooManyValues();
    return JSON.parse(utf8.decode(bytes));
  };
  const out: ParsedModel = { manifest: undefined as unknown as ModelManifest, datasets: [], guides: new Map(), metrics: [], terms: [], relationships: [], invalid: [] };
  const unreadable = msg.modelObjectUnreadable();
  try {
    const head = entries.get('model.json');
    const manifest = head ? Manifest.safeParse(await json(head).catch((e: unknown) => { if (e instanceof TooManyValues) throw e; return null; })) : null;
    if (!manifest?.success || manifest.data.format !== MODEL_FORMAT) return { refused: msg.modelNotAModel() };
    if (manifest.data.formatVersion > MODEL_VERSION) return { refused: msg.modelTooNew(String(manifest.data.formatVersion)) };
    out.manifest = manifest.data as ModelManifest;

    const seen = new Set<string>();
    const one = async <T extends { id: string }>(p: string, bytes: Uint8Array, schema: z.ZodType<T>, list: T[], kind: string): Promise<T | null> => {
      let raw: unknown;
      try {
        raw = await json(bytes);
      } catch (e) {
        if (e instanceof TooManyValues) throw e;
        out.invalid.push({ path: p, error: unreadable });
        return null;
      }
      return take(p, raw, schema, list, kind);
    };
    const take = <T extends { id: string }>(p: string, raw: unknown, schema: z.ZodType<T>, list: T[], kind: string): T | null => {
      const r = schema.safeParse(raw);
      const id = raw && typeof raw === 'object' && isValidId((raw as { id?: unknown }).id) ? (raw as { id: string }).id : undefined;
      if (!r.success) {
        out.invalid.push({ path: p, error: unreadable, ...(id && { id }) });
        return null;
      }
      if (seen.has(`${kind}:${r.data.id}`)) {
        out.invalid.push({ path: p, error: msg.modelDuplicateId(), id: r.data.id });
        return null;
      }
      seen.add(`${kind}:${r.data.id}`);
      list.push(r.data);
      return r.data;
    };

    const paths = [...entries.keys()].sort();
    const bySlug = new Map<string, string>(); // a dataset's slug → its id
    for (const p of paths) {
      const bytes = entries.get(p) as Uint8Array;
      const slug = /^datasets\/(.+)\.json$/.exec(p)?.[1];
      if (slug) {
        const d = await one(p, bytes, Dataset as z.ZodType<ModelDataset>, out.datasets, 'dataset');
        if (d) bySlug.set(slug, d.id);
      } else if (p.startsWith('metrics/')) await one(p, bytes, Metric as z.ZodType<ModelMetric>, out.metrics, 'metric');
      else if (p.startsWith('terms/')) await one(p, bytes, Term as z.ZodType<ModelTerm>, out.terms, 'term');
      else if (p === 'relationships.json') {
        let raw: unknown;
        try {
          raw = await json(bytes);
        } catch (e) {
          if (e instanceof TooManyValues) throw e;
        }
        const list = (raw as { relationships?: unknown } | null)?.relationships;
        if (!Array.isArray(list) || list.length > MAX_RELATIONSHIPS) out.invalid.push({ path: p, error: unreadable });
        else for (const r of list) take(p, r, Relationship as z.ZodType<ModelRelationship>, out.relationships, 'relationship');
      }
    }
    for (const p of paths) {
      const slug = /^datasets\/(.+)\.md$/.exec(p)?.[1];
      if (!slug) continue;
      const id = bySlug.get(slug);
      let text: string | null = null;
      try {
        text = utf8.decode(entries.get(p) as Uint8Array).trim();
      } catch (_) {
        /* not UTF-8: unreadable, below */
      }
      if (!id || text === null) out.invalid.push({ path: p, error: unreadable, ...(id && { id }) });
      else if (text.length > MAX_GUIDE) {
        // Its dataset goes with it: read without its guide, the plan would clear the one stored.
        out.invalid.push({ path: p, error: msg.modelGuideTooLong(), id });
        out.datasets = out.datasets.filter((d) => d.id !== id);
      } else if (text) out.guides.set(id, text);
    }
  } catch (e) {
    if (e instanceof TooManyValues) return { refused: msg.modelTooManyValues() };
    throw e;
  }
  return out;
}

/** An uploaded zip (a local file), through the zip reader and MODEL_POLICY. Closed before it returns. */
export async function readModelZip(file: string): Promise<ModelRead> {
  let reader: ZipReader;
  const entries = new Map<string, Uint8Array>();
  try {
    reader = await openZip({ file }, MODEL_POLICY);
  } catch (err) {
    if (err instanceof ZipRefused) return { refused: err.message };
    throw err;
  }
  try {
    for (const e of reader.entries) entries.set(e.name, await reader.read(e));
  } catch (err) {
    if (err instanceof ZipRefused) return { refused: err.message };
    throw err;
  } finally {
    await reader.close();
  }
  return parseEntries(entries);
}

/** The same files inline (path → text): the same whitelist, caps, total and value budget as a zip. */
export async function readModelFiles(files: ReadonlyMap<string, string>): Promise<ModelRead> {
  if (files.size > MODEL_POLICY.maxEntries) return { refused: bundleMsg.tooManyFiles() };
  const entries = new Map<string, Uint8Array>();
  let total = 0;
  for (const [name, text] of files) {
    if (MODEL_POLICY.refuseName(name)) return { refused: msg.modelEntryRefused(shown(name)) };
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MODEL_POLICY.capOf(name)) return { refused: bundleMsg.entryTooLarge(shown(name)) };
    if ((total += bytes.length) > MODEL_POLICY.maxTotal) return { refused: bundleMsg.tooLarge() };
    entries.set(name, bytes);
  }
  return parseEntries(entries);
}
