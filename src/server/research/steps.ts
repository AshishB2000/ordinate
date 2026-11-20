// One research step, computed THROUGH the doors an ask uses, as the starter (the caller's request context): an answer spec
// through `checkAction` and `computeCard` (row rules, hidden columns, folders, the Live budget), a drivers request through
// `runDrivers`, an SQL answer through `sqlAnswer` (its gates: closed or ruled datasets refused before any SQL is written, the
// Query tab's compile gate, the hourly Live limit). Nothing here computes a figure: it hands facts back for the model.
// The card is never kept; its spec is, and the report page draws it again live (./cards.ts).
//
// A step the app refuses (a name that does not exist, data this person may not use) is `refused`: no engine query. A step
// that reached the engine and failed is `failed`. Reasons are the app's own sentences; a thrown error's text never goes in.

import type { Computed } from '../../ai/researchLoop';
import type { ResearchAction } from '../../ai/researchActions';
import { checkAction } from '../../ipc/answerCheck';
import { computeCard } from '../../ipc/answers';
import { runDrivers, specFrom } from '../../ipc/drivers';
import { sqlAnswer } from '../../ipc/answerSql';
import { specDatasets } from '../../ipc/specVocabulary';
import { driversFacts } from '../../ai/driversFacts';
import { sqlFacts } from '../../ai/researchPrompts';
import { relatedIds } from '../../ai/answerJoin';
import { tidy } from '../../ai/researchWrite';
import { FIGURE_RE } from '../../app/instructions';
import { isRowPolicyError } from '../../data/rowPolicyError';
import * as say from '../researchMessages';

export interface StepScope { projectId: string; question: string; only: ReadonlySet<string> | null; model: { provider: string; model: string } | null }

/** A title the browser may show: one line, no model figure. */
const titled = (raw: string, fallback: string): string => {
  const s = tidy(raw, 120).replace(/\n+/g, ' ');
  return s && !FIGURE_RE.test(s) ? s : fallback;
};

const failure = (err: unknown): Computed => (isRowPolicyError(err) ? { status: 'refused', reason: say.notAllowed() } : { status: 'failed', reason: say.stepFailed() });

export async function computeStep(action: Exclude<ResearchAction, { kind: 'done' }>, sc: StepScope): Promise<Computed> {
  try {
    if (action.kind === 'answer') return await answerStep(action, sc);
    if (action.kind === 'sql') return await sqlStep(action, sc);
    return await driversStep(action, sc);
  } catch (err) {
    return failure(err);
  }
}

async function answerStep(action: Extract<ResearchAction, { kind: 'answer' }>, sc: StepScope): Promise<Computed> {
  // `noSources`: never the project's source tables (an answer over one names no document a folder or a rule is recorded for).
  const v = await checkAction(sc.projectId, { kind: '', noSources: true } as { kind: string }, { kind: 'answer', intent: action.intent, spec: action.spec }, sc.question, undefined, undefined, sc.only ?? undefined);
  if (!v.ok) return { status: 'refused', reason: v.reason };
  const built = await computeCard(sc.projectId, v.spec, true);
  if ('ok' in built) return { status: 'failed', reason: built.reason, title: titled(v.spec.title, '') };
  const spec = built.card.spec;
  return {
    status: 'done', title: titled(built.card.title, built.card.datasetName), spec: spec as unknown as Record<string, unknown>,
    facts: built.factsText, ledger: built.ledger, datasetIds: [...new Set([spec.datasetId, ...relatedIds(spec)])],
  };
}

async function sqlStep(action: Extract<ResearchAction, { kind: 'sql' }>, sc: StepScope): Promise<Computed> {
  const res = await sqlAnswer(sc.projectId, { kind: 'sql', intent: action.intent, datasets: action.datasets }, sc.question, sc.only ?? undefined, sc.model);
  if (!res.ok) return { status: 'failed', reason: res.reason };
  const facts = sqlFacts(res.card);
  const title = titled(res.sql.title, 'SQL result');
  return { status: 'done', title, spec: { sql: res.sql.text, datasetIds: res.sql.datasetIds, title }, facts: facts.text, ledger: facts.ledger, datasetIds: res.sql.datasetIds };
}

async function driversStep(action: Extract<ResearchAction, { kind: 'drivers' }>, sc: StepScope): Promise<Computed> {
  const req: Record<string, unknown> = { ...action.request };
  // The model names the dataset; the app finds its id among the datasets this person may use (and the agent's topic).
  const name = typeof req.dataset === 'string' ? req.dataset.trim().toLowerCase() : '';
  const all = (await specDatasets(sc.projectId)).filter((d) => !sc.only || sc.only.has(d.id));
  const ds = name ? all.find((d) => d.name.trim().toLowerCase() === name) : all.find((d) => d.id === req.datasetId);
  if (!ds) return { status: 'refused', reason: say.datasetUnknown() };
  const got = specFrom({ ...req, datasetId: ds.id });
  if (!got) return { status: 'refused', reason: say.replyShape() };
  const r = await runDrivers(sc.projectId, got.spec, got.params);
  if (!r.ok) return { status: 'failed', reason: say.stepFailed() };
  const facts = driversFacts(r);
  const spec = { ...got.spec, ...(r.selected ? { dimension: r.selected.column } : {}) };
  return { status: 'done', title: titled(`Why ${r.metric.name} changed`, 'Why it changed'), spec: spec as unknown as Record<string, unknown>, facts: facts.text, ledger: facts.ledger, datasetIds: [ds.id] };
}
