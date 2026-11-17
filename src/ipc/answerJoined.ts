// The figures of an answer whose category or split is a RELATED dataset's column (docs/assistant/00-design.md, "Joins,
// as built") — MAIN PROCESS. Not a second join: the card asks THE chart door (./visuals `vizDataFor`) with the spec's
// encoding (../ai/answerJoin `specEncoding`), so the join plan (many → one only, the reverse refused in the planner's
// sentence), the fan-out rules, the folder check, row lock and hidden columns of every table it reads, and the orgKey
// answer cache are a visual's own. A spec with no related field never comes here: ./answers draws it on its rows.
//
// A Live dataset on either side is refused in the chart door's own typed sentence (`live_refused`), never `live_dataset`:
// Live joins are built in ../engine/live, and until a Live chart follows a link, no answer does.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { VizDataResult } from '../analysis/vizData';
import { isLive } from '../data/liveDataset';
import { hiddenColumnsFor } from '../data/rowAccess';
import { RowPolicyError, type RowPolicyReason } from '../data/rowPolicyError';
import { FolderError, isFolderError, type FolderReason } from '../server/authz/folders';
import { folderGate } from '../server/authz/folderGate';
import { TERM_CODE } from '../data/termStep';
import { dropHidden } from '../ai/hiddenFacts';
import { withheldColumns } from '../app/sharePolicy';
import { liveRelatedRefused } from '../engine/liveRefusals';
import type { LiveFailureCode } from '../engine/live/liveQuery';
import { relatedIds, specEncoding } from '../ai/answerJoin';
import type { AnswerSpec, SpecDataset } from '../ai/answerSpec';
import { chartReads } from './relationships';
import { vizDataFor } from './visuals';
import type { Failure } from './answers';

/** A related side as the card reads it: its record, and its columns as the caller sees them (a hidden one is no chip). */
export interface JoinedSide { meta: DatasetMeta; columns: ParsedColumn[] }

/** `withheld`: the category or split names a related dataset marks personal or financial (a model never reads their labels). */
export interface Joined { ok: true; category?: JoinedSide; series?: JoinedSide; withheld: string[]; metas: DatasetMeta[] }

/**
 * The related sides of a joined spec, or why its card cannot be drawn: a Live dataset on either side (typed), a related
 * dataset in a folder the caller cannot open or only reaches (typed `folder`), or a related column no longer there. A
 * related dataset that is gone is left to the planner, which says so.
 */
export async function joinedSides(projectId: string, spec: AnswerSpec): Promise<Joined | Failure> {
  const own = await datasets.getDatasetMeta(projectId, spec.datasetId);
  const out: Joined = { ok: true, withheld: [], metas: [] };
  if (isLive(own)) return { ok: false, reason: liveRelatedRefused(), code: 'live_refused' };
  for (const [key, id, column] of [['category', spec.categoryDatasetId, spec.category], ['series', spec.seriesDatasetId, spec.series]] as const) {
    if (!id || !column || id === spec.datasetId) continue;
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (!meta) {
      // A folder the caller cannot open, or one they only REACH (D9): refused as the answer door refuses its own dataset
      // (`open`: `closed` / `figures_only`), raised and caught so the route types it. Else it is gone: the planner says so.
      try {
        await folderGate(projectId, id, undefined, 'open');
      } catch (err) {
        if (isFolderError(err)) return { ok: false, reason: err.message };
        throw err;
      }
      continue;
    }
    if (isLive(meta)) return { ok: false, reason: liveRelatedRefused(), code: 'live_refused' };
    if (!meta.columns.some((c) => c.name === column)) return { ok: false, reason: `"${column}" is no longer a column of ${meta.name}.` };
    out[key] = { meta, columns: dropHidden(meta.columns, await hiddenColumnsFor(projectId, id)) };
    if ((await withheldColumns(projectId, id)).has(column)) out.withheld.push(column);
    if (!out.metas.includes(meta)) out.metas.push(meta);
  }
  return out;
}

const LIVE_CODES: ReadonlySet<string> = new Set<LiveFailureCode>(['live_refused', 'live_unavailable', 'live_failed', 'live_timeout', 'live_cancelled']);

/** The chart's figures through THE chart door, as a visual of this encoding draws them. A refusal keeps its type, as the answer door's do. */
export async function joinedViz(projectId: string, spec: AnswerSpec, steps: FilterStep[]): Promise<Pick<VizDataResult, 'data' | 'warnings' | 'category'> | Failure> {
  const r = await vizDataFor(projectId, spec.datasetId, specEncoding(spec), steps);
  if (r.ok) return { data: r.data, warnings: [...r.warnings, ...(r.notes ?? []).filter((n) => !r.warnings.includes(n))], ...(r.category ? { category: r.category } : {}) };
  // A row access or folder refusal is raised and caught HERE, so the route types the reply that carries its sentence
  // (rowPolicyRaised / folderRaised: answer:card's `{ok:false}`), and an ask keeps its turn with "(No chart: …)".
  if (r.code === 'row_policy') return { ok: false, reason: new RowPolicyError(r.reason as RowPolicyReason).message };
  if (r.code === 'folder') return { ok: false, reason: new FolderError(r.reason as FolderReason).message };
  const code = r.code === TERM_CODE || (r.code && LIVE_CODES.has(r.code)) ? { code: r.code as Failure['code'] } : {};
  return { ok: false, reason: r.error, ...code };
}

/** Every dataset a joined answer reads, its own first: the related ones and its join plan's tables (./relationships chartReads). */
export async function answerReads(projectId: string, spec: AnswerSpec): Promise<string[]> {
  return [...new Set([spec.datasetId, ...relatedIds(spec), ...(await chartReads(projectId, spec.datasetId, specEncoding(spec), []))])];
}

/**
 * A stored joined spec's related datasets as the validator reads them, and their names; null when one is gone or no
 * longer has its column (by exact name, as the card reads it): a follow-up then starts afresh.
 */
export async function relatedOfStored(projectId: string, spec: AnswerSpec): Promise<{ datasets: SpecDataset[]; on: { category?: string; series?: string } } | null> {
  const out: SpecDataset[] = [];
  const on: { category?: string; series?: string } = {};
  for (const [key, id, column] of [['category', spec.categoryDatasetId, spec.category], ['series', spec.seriesDatasetId, spec.series]] as const) {
    if (!id || !column) continue;
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (!meta || !meta.columns.some((c) => c.name === column)) return null;
    on[key] = meta.name;
    if (!out.some((d) => d.id === meta.id)) out.push({ id: meta.id, name: meta.name, columns: meta.columns });
  }
  return { datasets: out, on };
}
