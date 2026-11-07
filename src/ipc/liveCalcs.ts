// A Live dataset's calculated fields (semantic layer part 8, step 04; docs/semantic-layer/08-engine.md D1,
// D6) — server, MAIN ONLY.
//
//   live:setCalculated   the editor's whole list, checked as every statement will read it
//                        (engine/live/liveCalcCheck) and stored with each formula's static type in ONE
//                        record write; this pod's cache cleared and open dashboards told. No epoch bump:
//                        the definitions travel in every cache key (engine/live/compile `LiveSource.calcs`).
//   live:checkCalc       the formula editor's check (ipc/formula's FormulaCheck shape) against the
//                        columns and the calcs before this one. No warehouse call and no sample rows: a
//                        statement per keystroke would spend LIVE_DAILY_QUERY_LIMIT.
//   dataset:liveSchema   (ipc/liveProfile) carries `liveCalculated`: each calc with its problem against the
//                        warehouse's columns now, names and types only to a caller row access restricts.
//
// Both `write`: only an editor changes or drafts a calc, and neither reply carries a row.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { isLive, setLiveCalcs } from '../data/liveDataset';
import type { DatasetMeta } from '../data/datasets';
import type { LiveCalc, LiveCalcType } from '../data/liveCalcs';
import { declaredColumns, redactCalcs } from '../data/liveCalcs';
import * as connections from '../connectors/connections';
import { getConnector } from '../connectors';
import type { CompileDialectId } from '../engine/live/dialect';
import { liveCalcBroken, liveCalcDialectRefused } from '../engine/liveRefusals';
import { announceRefreshed } from '../data/refreshEvents';
import * as msg from '../data/liveMessages';
import { compile, type SourceSpan } from '../formula/formula';
import { tokenize, type Tok } from '../formula/formulaTokens';
import { nearestColumn } from '../formula/didYouMean';
import type { CalcValueType } from '../engine/live/formulaSql';
import { checkCalc } from '../engine/live/formulaSql';
import { calcsRefusedOn, validateLiveCalcs } from '../engine/live/liveCalcCheck';
import type { LiveTarget } from '../engine/live/liveTarget';
import { liveTarget, typedColumns } from '../engine/live/liveTarget';
import type { LiveColumn } from '../engine/live/liveSpec';
import { liveDatasetMissing } from '../engine/liveQueryMessages';
import * as queryCache from '../engine/queryCache';
import type { FormulaCheck, ResultType } from './formula';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

type Failure = { ok: false; code?: string; reason?: string; error: string; index?: number; at?: SourceSpan };
export type SetCalculatedReply = { ok: true; calculated: LiveCalc[] } | Failure;

/** The dataset's question target (its dialect, typed columns and current calcs), or why there is none. */
async function targetOf(projectId: string, datasetId: string): Promise<{ ok: true; t: LiveTarget; declared: LiveColumn[] } | Failure> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: liveDatasetMissing() };
  if (!isLive(meta)) return { ok: false, code: 'not_live', error: msg.liveCalcNotLiveMessage() };
  // No warehouse call: the connection, its dialect and the secrets loader only (secrets are read on a first statement).
  const found = await liveTarget(projectId, datasetId);
  if (!found.ok) {
    return found.kind === 'refused'
      ? { ok: false, code: 'live_refused', reason: found.refusal.code, error: found.refusal.message }
      : { ok: false, code: 'live_unavailable', error: found.error };
  }
  return { ok: true, t: found.target, declared: declaredColumns({ columns: found.target.columns, live: found.target.live }) };
}

export async function setCalculated(p: Record<string, unknown>): Promise<SetCalculatedReply> {
  const projectId = str(p.projectId);
  const datasetId = str(p.datasetId);
  const found = await targetOf(projectId, datasetId);
  if (!found.ok) return found;
  const asked = (Array.isArray(p.calculated) ? p.calculated : []) as { name: string; expression: string }[];
  const v = validateLiveCalcs(found.declared, asked, found.t.dialect);
  if (!v.ok) return v;
  if (!(await setLiveCalcs(projectId, datasetId, v.calculated))) return { ok: false, code: 'not_live', error: msg.liveCalcNotLiveMessage() };
  queryCache.invalidateDataset(datasetId, projectId);
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  announceRefreshed({ projectId, datasetId, name: meta?.name ?? '', rowsBefore: 0, rowsAfter: 0 });
  return { ok: true, calculated: v.calculated };
}

const RESULT: Record<CalcValueType, ResultType | null> = { number: 'number', text: 'string', boolean: 'logical', date: 'date', null: null };

function failedCheck(tokens: Tok[], error: string, at?: SourceSpan, refs: string[] = [], unknownRefs: FormulaCheck['unknownRefs'] = []): FormulaCheck {
  return { tokens, ok: false, error, ...(at ? { at } : {}), refs, unknownRefs, resultType: null, sample: { columns: [], rows: [], note: msg.liveCalcNoPreviewMessage() } };
}

export async function checkLiveCalc(p: Record<string, unknown>): Promise<FormulaCheck> {
  const src = str(p.expression);
  let tokens: Tok[] = [];
  try {
    tokens = tokenize(src);
  } catch {
    /* compile() below reports the same failure, with its position */
  }
  const parsed = compile(src);
  if (!parsed.ok) return failedCheck(tokens, parsed.error, parsed.at);
  const found = await targetOf(str(p.projectId), str(p.datasetId));
  if (!found.ok) return failedCheck(tokens, found.error);
  const stored = found.t.live.calculated ?? [];
  // `before`: where this calc sits in the list (the one being edited, or the end for a new one).
  const before = typeof p.before === 'number' ? Math.min(Math.max(0, Math.floor(p.before)), stored.length) : stored.length;
  const earlier = stored.slice(0, before);
  const known = [...found.declared.map((c) => c.name), ...earlier.map((c) => c.name)];
  const refs = parsed.fn.refs;
  const unknownRefs = refs.filter((r) => !known.includes(r)).map((name) => {
    const didYouMean = nearestColumn(name, known);
    return didYouMean === undefined ? { name } : { name, didYouMean };
  });
  if (calcsRefusedOn(found.t.dialect)) return failedCheck(tokens, msg.liveCalcDatabricksMessage(), undefined, refs, unknownRefs);
  const v = checkCalc(src, found.declared, earlier, stored.slice(before + 1));
  if (!v.ok) return failedCheck(tokens, v.error, v.at, refs, unknownRefs);
  return { tokens, ok: true, refs, unknownRefs, resultType: RESULT[v.result], sample: { columns: [], rows: [], note: msg.liveCalcNoPreviewMessage() } };
}

/** One calc on the Schema tab: `problem` is why it no longer runs on the warehouse's columns now. */
export interface CalcField { name: string; expression: string; type: LiveCalcType; problem?: string; hidden?: true }
/** `allowed`: false where calcs are refused (Databricks), with `why`. */
export interface CalculatedView { allowed: boolean; why?: string; fields: CalcField[] }

/** The Schema reply's calcs, against the declared columns: each checked as a statement would compile it (./calcLayers). PURE. */
export function calculatedView(meta: Pick<DatasetMeta, 'columns' | 'live'>, dialect: CompileDialectId | null, closed: boolean): CalculatedView {
  const calcs = meta.live?.calculated ?? [];
  const declared = declaredColumns({ columns: typedColumns(meta), live: meta.live });
  const clash = new Set(declared.map((c) => c.name.toLowerCase()));
  const fields: CalcField[] = calcs.map((c, i) => {
    const v = checkCalc(c.expression, declared, calcs.slice(0, i), calcs.slice(i + 1));
    const problem = clash.has(c.name.toLowerCase()) ? msg.liveCalcNameIsColumnMessage(c.name) : !v.ok ? v.error : v.type !== c.type ? liveCalcBroken(c.name) : undefined;
    return problem ? { ...c, problem } : { ...c };
  });
  const refused = dialect !== null && calcsRefusedOn(dialect);
  return { allowed: !refused, ...(refused ? { why: liveCalcDialectRefused() } : {}), fields: redactCalcs(fields, closed) };
}

/** `calculatedView` for a stored Live dataset: its connection's dialect (none when the connection is gone). */
export async function liveCalculated(projectId: string, meta: DatasetMeta, closed: boolean): Promise<CalculatedView> {
  const o = meta.origin;
  const conn = o?.kind === 'connection' ? await connections.getConnection(projectId, o.connId) : null;
  const dialect = (conn && getConnector(conn.connectorId)?.live?.dialect) ?? null;
  return calculatedView(meta, dialect, closed);
}

export function register(): void {
  ipcMain.handle('live:setCalculated', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await setCalculated(payload);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save the calculated fields' };
    }
  });
  ipcMain.handle('live:checkCalc', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await checkLiveCalc(payload);
    } catch (err: unknown) {
      // A check must never reject: the editor calls it on every keystroke.
      return failedCheck([], err instanceof Error ? err.message : 'Could not check the formula');
    }
  });
}
