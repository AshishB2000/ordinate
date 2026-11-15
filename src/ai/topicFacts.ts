// The Assistant's facts for a topic (semantic part 6, D14–D15) — MAIN PROCESS. A question asked in a topic's context
// sees that topic's datasets (in its order, with their fields' notes), its metrics and its terms, and no more.
//
// It narrows and never widens: every dataset's notes go through the same readers the project inventory uses
// (`assistantColumnDocs`, `closedToCaller`, a copy's sample values), so a caller the rules restrict gets no value list a
// topic would otherwise carry, and a term's filter values are worded as `termFactsFor` words them. A column hidden from
// the caller, and a metric or term that reads one, is not named at all (part 4, D21). No figure here, so no ledger entry.
// A topic that is gone gives null and `buildFacts` falls through to the project inventory.

import * as copilot from './copilot';
import type { CopilotFacts } from './copilot';
import { termLines, type FactTerm } from './termFacts';
import { withheldColumns } from './columnNotes';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import * as terms from '../analysis/terms';
import { describeDefinitionShort } from '../analysis/metricFormat';
import { readTopic, topicForReaders } from '../analysis/topics';
import { tableFacts } from '../app/tableDocs';
import { assistantColumnDocs } from '../app/sharePolicy';
import { closedToCaller, hiddenColumnsFor, restrictedOn } from '../data/rowAccess';
import { liveInventoryNotes } from '../ipc/liveProfile';
import { copyValueNotes } from '../ipc/copyValues';
import { dropHidden, tableWithout } from './hiddenFacts';
import { metricHidden, termHidden } from '../analysis/columnHidden';
import type { ActivityEmit } from '../ipc/copilot';
import { bodyOf, readTexts } from '../app/recordTexts';
import { isValidId } from '../app/ids';

const CLOSING = '\n\nNo specific dataset/visual/dashboard is open';

/** `agent`: an Assistant agent's topic (src/ipc/agentAsk.ts), which it answers from alone; else a topic the screen is on. */
export async function topicFacts(projectId: string, id: string, emit: ActivityEmit, agent = false): Promise<CopilotFacts | null> {
  const stored = await readTopic(projectId, id);
  if (!stored) return null;
  const { topic } = await topicForReaders(projectId, stored.rec);
  emit({ kind: 'read', label: 'Read the topic ' + topic.name });
  const proj = await projects.getProject(projectId);

  const sets: { name: string; fields?: string[]; all: string[] }[] = [];
  const schemas = [];
  for (const d of topic.datasets) {
    const m = await datasets.getDatasetMeta(projectId, d.id);
    if (!m) continue;
    const hidden = await hiddenColumnsFor(projectId, m.id);
    const shown = dropHidden(m.columns, hidden);
    const keep = d.fields ? new Set(d.fields) : null;
    const columns = keep ? shown.filter((c) => keep.has(c.name)) : shown;
    sets.push({ name: m.name, fields: d.fields, all: shown.filter((c) => !keep || !keep.has(c.name)).map((c) => c.name) });
    schemas.push({
      name: m.name, columns, docs: await assistantColumnDocs(projectId, m.id), table: tableWithout(await tableFacts(projectId, m.id), hidden),
      notes: (await closedToCaller(projectId, m.id)) ? undefined : ((await liveInventoryNotes(projectId, m)) ?? (await copyValueNotes(projectId, m.id, 'inventory'))),
    });
  }
  const base = copilot.projectFacts(proj ? proj.name : 'Untitled project', { datasets: sets.map((s) => s.name), visuals: [], dashboards: [] }, schemas);

  const about = agent ? 'they are all this assistant answers from, and a question about other data is outside them' : 'the project holds more, which a question may still name';
  const lines: string[] = [`Topic: "${topic.name}"${topic.description ? ` — ${topic.description}` : ''}. Its datasets, metrics and terms are listed here; ${about}.`];
  for (const s of sets) if (s.fields && s.all.length) lines.push(`- ${s.name} also has, outside this topic: ${s.all.join(', ')}`);
  lines.push(...await modelLines(projectId, topic.metricIds, topic.termIds, 'Topic metrics (the app computes their figures):'));

  const at = base.text.indexOf(CLOSING);
  const head = base.text.slice(0, at < 0 ? undefined : at).split('\n').filter((l) => !/^(Visuals|Dashboards) \(0\): \(none\)\.$/.test(l)).join('\n');
  const tail = 'A question answerable from these columns can be answered with an "answer" action; the app computes it.';
  return { ...base, text: `${head}\n\n${lines.join('\n')}\n\n${tail}` };
}

/**
 * The lines that name `metricIds` (under `heading`) and `termIds`, in their order: a metric by its short definition, a
 * term by its filters in words (a value withheld as `termFactsFor` withholds it). One that is gone, or that reads a column
 * hidden from the caller, is not named. Their own records only, in one query (../app/recordTexts): never a list.
 */
export async function modelLines(projectId: string, metricIds: readonly string[], termIds: readonly string[], heading: string): Promise<string[]> {
  const lines: string[] = [];
  const file = (id: string) => metrics.metricFilePath(projectId, id);
  const textOf = await readTexts([...metricIds.map(file), ...termIds.map((id) => terms.termFile(projectId, id))]);
  const summary = (body: string | null): metrics.MetricSummary | null => { try { return body === null ? null : metrics.summaryOf(projectId, body); } catch (_) { return null; } };
  const own: metrics.MetricSummary[] = [];
  for (const mid of metricIds) { const m = isValidId(projectId) && isValidId(mid) ? summary(bodyOf(textOf, file(mid))) : null; if (m && !(await metricHidden(projectId, m.id))) own.push(m); }
  if (own.length) {
    lines.push('', heading);
    // A period metric: by its base's name (part 5).
    const baseName = async (m: metrics.MetricSummary) => (metrics.isPeriodDefinition(m.definition) ? (await metrics.getMetric(projectId, m.definition.base))?.name : undefined);
    for (const m of own) lines.push(`- Metric ${m.name}: ${describeDefinitionShort(m.definition, await baseName(m))}`);
  }
  const hideAll = await restrictedOn(projectId);
  const facts: FactTerm[] = [];
  for (const tid of termIds) {
    const t = await terms.getTerm(projectId, tid, textOf(terms.termFile(projectId, tid)));
    if (!t || (await termHidden(projectId, t.id))) continue;
    const withheld = withheldColumns(await assistantColumnDocs(projectId, t.datasetId));
    facts.push({ name: t.name, aliases: t.aliases, ...(t.description ? { description: t.description } : {}), definition: terms.describeTermFilters(t, (s) => hideAll || withheld.has(s.column)) });
  }
  termLines(lines, facts);
  return lines;
}
