// Text analytics IPC — the column profile's "Text" section, the text steps'
// live previews, and their save path. Every figure is computed here in main.
//
//   text:profile     a text column's profile over its first TEXT_SAMPLE_CAP
//                    filled values, read RESIDENT (no hydration) with the JS
//                    reference as the fallback
//   text:preview     what an unsaved text step would do to its real input
//                    (the first PREVIEW_ROWS rows of it on a big table — said so)
//   text:commitStep  add or replace a text step. On a big table the per-row
//                    work runs as a `compute` JOB first — chunked, with progress
//                    and Cancel — and the ordinary save path then finds it warm
//                    (data/stepsText.ts); a small table saves directly.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as jobs from '../app/jobs';
import * as trace from '../engine/residentTrace';
import { applyPipelineAsync } from '../data/regexOffThread';
import type { Cell, TableData, TransformStep } from '../data/transforms';
import { checkTextStep, sentimentColumnName, categoryColumnName } from '../data/textStepTypes';
import type { TextStep } from '../data/textStepTypes';
import { WARM_MIN_ROWS, dropWarm, warmTextStep } from '../data/stepsText';
import { loadStepRefs } from '../data/stepRefs';
import { saltForSteps } from '../app/privacyStore';
import { commitSteps } from './datasets';
import { forClient } from './stepReply';
import { textSampleResident } from '../engine/textSampleResident';
import { TEXT_SAMPLE_CAP, profileText, textSampleOf } from '../analysis/text/textProfile';
import { isTextLang } from '../analysis/text/tokenize';

/** A save over at least this many rows runs its text work as a job. */
export const JOB_MIN_ROWS = Math.max(WARM_MIN_ROWS, 100_000);
/** A preview reads at most this many rows of the step's input. */
export const PREVIEW_ROWS = 5_000;

// ── text:profile ─────────────────────────────────────────────────────────────

export async function textProfile(projectId: string, datasetId: string, column: string, lang?: unknown): Promise<unknown> {
  let values: string[] | null = null;
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    // Settled by the schema alone — no query, and above all no hydrate.
    const declared = src.columns.find((c) => c && c.name === column);
    if (!declared || declared.type !== 'text') return { ok: true, profile: null };
    values = await textSampleResident(src, column, TEXT_SAMPLE_CAP);
    trace.record('textProfile', values ? 'resident' : 'failed', values ? undefined : `${src.columns.length} cols`);
  } else {
    trace.record('textProfile', 'skipped');
  }
  if (!values) {
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return { ok: false, error: 'Dataset not found' };
    values = textSampleOf(ds.columns, ds.rows, column, TEXT_SAMPLE_CAP);
  }
  if (!values) return { ok: true, profile: null };
  const p = profileText(values, isTextLang(lang) ? lang : undefined);
  // The bars, and the sentiment's word (VADER's ±0.05), decided here with the figures.
  const mean = p.sentiment ? p.sentiment.mean : 0;
  return {
    ok: true,
    profile: {
      ...p,
      topTerms: withShares(p.topTerms),
      topBigrams: withShares(p.topBigrams),
      ...(p.sentiment ? { mood: mean >= 0.05 ? 'positive' : mean <= -0.05 ? 'negative' : 'neutral' } : {}),
    },
  };
}

// ── the step's input (what the fold would hand it) ───────────────────────────

async function stepInput(projectId: string, datasetId: string, index: number, extra: TransformStep): Promise<{
  input: TableData; steps: TransformStep[]; name: string;
} | null> {
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  const source: TableData = ds.source ?? { columns: ds.columns, rows: ds.rows };
  const steps = ds.steps || [];
  const at = Number.isInteger(index) && index >= 0 && index < steps.length ? index : steps.length;
  const prefix = steps.slice(0, at);
  // The same context updateSteps folds with — the salt and the other datasets
  // a union/lookup reads — so the warm key matches the fold's input exactly.
  const ctx = { salt: await saltForSteps(projectId, prefix), ...(await loadStepRefs(projectId, datasetId, [...prefix, extra])) };
  // ponytail: the prefix is folded in full per call, as prepare:stepPreview does; the resident path could serve it
  const input = prefix.length ? await applyPipelineAsync(source, prefix, ctx) : source;
  const next = steps.slice();
  if (at < steps.length) next[at] = extra;
  else next.push(extra);
  return { input: { columns: input.columns, rows: input.rows }, steps: next, name: ds.name };
}

// ── text:preview ─────────────────────────────────────────────────────────────

const clip = (s: string): string => (s.length > 140 ? s.slice(0, 139) + '…' : s);

export async function textPreview(projectId: string, datasetId: string, index: number, raw: unknown): Promise<unknown> {
  const step = checkTextStep((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>);
  if (typeof step === 'string') return { ok: false, error: step };
  const at = await stepInput(projectId, datasetId, index, step);
  if (!at) return { ok: false, error: 'Dataset not found' };
  const total = at.input.rows.length;
  const sample: TableData = total > PREVIEW_ROWS ? { columns: at.input.columns, rows: at.input.rows.slice(0, PREVIEW_ROWS) } : at.input;
  const out = await applyPipelineAsync(sample, [step]);
  const res: Record<string, unknown> = {
    ok: true, before: sample.rows.length, after: out.rowCount, warnings: out.warnings,
    sampled: total > PREVIEW_ROWS, total, sampleRows: sample.rows.length,
  };
  const ci = out.columns.length - 1;
  if (step.type === 'text_terms') {
    res.columns = out.columns.map((c) => c.name);
    res.rows = out.rows.slice(0, 12);
  } else if (step.type === 'text_sentiment' && out.columns[ci] && out.columns[ci].name === sentimentColumnName(step)) {
    res.sentiment = sentimentSummary(out.rows, ci, out.columns.findIndex((c) => c.name === step.column));
  } else if (step.type === 'keyword_rules' && out.columns[ci] && out.columns[ci].name === categoryColumnName(step)) {
    res.categories = categorySummary(out.rows, ci, step);
  }
  return res;
}

function sentimentSummary(rows: Cell[][], ci: number, ti: number): unknown {
  let scored = 0;
  let sum = 0;
  const bands = [0, 0, 0]; // negative, neutral, positive — VADER's ±0.05 convention
  let lo: Cell[] | null = null;
  let hi: Cell[] | null = null;
  for (const r of rows) {
    const v = r[ci];
    if (typeof v !== 'number') continue;
    scored += 1;
    sum += v;
    bands[v <= -0.05 ? 0 : v < 0.05 ? 1 : 2] += 1;
    if (!lo || v < (lo[ci] as number)) lo = r;
    if (!hi || v > (hi[ci] as number)) hi = r;
  }
  const ex = (r: Cell[] | null) => (r && ti >= 0 ? { text: clip(String(r[ti] ?? '')), score: r[ci] } : null);
  return {
    scored, empty: rows.length - scored, mean: scored ? sum / scored : null,
    negative: bands[0], neutral: bands[1], positive: bands[2],
    examples: [ex(hi), ex(lo)].filter((e) => e !== null),
  };
}

function categorySummary(rows: Cell[][], ci: number, step: Extract<TextStep, { type: 'keyword_rules' }>): unknown {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r[ci] === null ? '' : String(r[ci]);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // Rule order first (the order that decides), then the default.
  const order: string[] = [];
  for (const rule of step.rules) if (!order.includes(rule.category)) order.push(rule.category);
  const other = step.otherwise === undefined || step.otherwise === null ? '' : step.otherwise;
  if (!order.includes(other)) order.push(other);
  return withShares(order.map((category) => ({ category, count: counts.get(category) || 0, isDefault: category === other })));
}

/**
 * Each row's share of the total (whole percent, `pct`) and its bar against the
 * largest (`barPct`, at least 2 when it has any) — the figures a preview prints
 * and draws, so a browser never divides one count by another.
 */
export function withShares<T extends { count: number }>(rows: T[]): Array<T & { pct: number; barPct: number }> {
  let total = 0;
  let max = 0;
  for (const r of rows) {
    total += r.count;
    if (r.count > max) max = r.count;
  }
  return rows.map((r) => ({
    ...r,
    pct: total ? Math.round((r.count / total) * 100) : 0,
    barPct: max > 0 ? Math.max(r.count ? 2 : 0, Math.round((r.count / max) * 100)) : 0,
  }));
}

// ── text:commitStep ──────────────────────────────────────────────────────────

export async function commitTextStep(projectId: string, datasetId: string, index: number, raw: unknown): Promise<unknown> {
  const step = checkTextStep((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>);
  if (typeof step === 'string') return { ok: false, error: step };
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  const current = meta.steps || [];
  const small = (meta.rowCount || 0) < JOB_MIN_ROWS;
  if (small) {
    const next = current.slice();
    if (Number.isInteger(index) && index >= 0 && index < next.length) next[index] = step;
    else next.push(step);
    return commitSteps(projectId, datasetId, next);
  }

  const verb = step.type === 'text_sentiment' ? 'Scoring sentiment' : step.type === 'keyword_rules' ? 'Tagging rows' : 'Counting terms';
  const job = jobs.submit({
    kind: 'compute',
    label: `${verb} · ${meta.name}`,
    projectId,
    datasetId,
    run: async (ctx) => {
      ctx.progress(0.02, 'Reading rows');
      const at = await stepInput(projectId, datasetId, index, step);
      if (!at) throw new Error('Dataset not found');
      const n = at.input.rows.length;
      let key: string | null = null;
      try {
        key = await warmTextStep(at.input, step, (p) => {
          ctx.progress(0.05 + 0.85 * p, `${Math.round(p * n).toLocaleString('en-US')} of ${n.toLocaleString('en-US')} rows`);
        }, () => ctx.signal.aborted);
        ctx.checkCancelled();
        ctx.progress(0.92, 'Saving');
        return await commitSteps(projectId, datasetId, at.steps);
      } finally {
        dropWarm(key); // taken by the fold on success; never left holding a table
      }
    },
    resultOf: (r: { ok: boolean }) => ({ message: r && r.ok ? 'Step saved' : 'Not saved' }),
  });
  try {
    return await job.done;
  } catch (err: any) { // ponytail: any thrown value, reported by its name/message only
    if (err && err.name === 'JobCancelled') return { ok: false, cancelled: true, error: 'Cancelled — the step was not added.' };
    return { ok: false, error: err?.message || 'Could not save the step' };
  }
}

// ponytail: IPC payloads are untrusted JSON envelopes (typed any, as in datasets.ts); every field is coerced before use.
export function register(): void {
  ipcMain.handle('text:profile', async (_e, { projectId, datasetId, column, lang }: any = {}) => {
    try {
      return await textProfile(String(projectId || ''), String(datasetId || ''), String(column || ''), lang);
    } catch (err: any) { // ponytail: any thrown value, reported by its message only
      return { ok: false, error: err?.message || 'Could not profile the column' };
    }
  });
  ipcMain.handle('text:preview', async (_e, { projectId, datasetId, index, step }: any = {}) => {
    try {
      return await textPreview(String(projectId || ''), String(datasetId || ''), Number(index), step);
    } catch (err: any) { // ponytail: any thrown value, reported by its message only
      return { ok: false, error: err?.message || 'Could not preview the step' };
    }
  });
  ipcMain.handle('text:commitStep', async (_e, { projectId, datasetId, index, step }: any = {}) => {
    try {
      return forClient(await commitTextStep(String(projectId || ''), String(datasetId || ''), Number(index), step));
    } catch (err: any) { // ponytail: any thrown value, reported by its message only
      return { ok: false, error: err?.message || 'Could not save the step' };
    }
  });
}
