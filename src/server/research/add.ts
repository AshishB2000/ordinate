// "Add to project" (docs/deep-research/00-design.md, "The report"), as the starter, idempotent:
//   1. each cited chart is saved through the path the dock's Save uses: an answer step as `answer:saveVisual` does (computeCard,
//      saveCardAsVisual: it lands with its dataset under the team-folder rules), a drivers step as `drivers:addTile` does. An SQL
//      step has no saved-chart path, so it stays out, with a caveat line. A chart is named `<report title> · <section heading>`.
//   2. the Story: summary, per section its heading, charts and prose, the caveats as a warning callout, a divider, the conclusion.
//      THE QUESTION-5 RULE: a part's prose is kept only when no cited step's dataset is restricted (`restricted()`, the Slack
//      check's own test: row rules, column rules, or a folder not open to everyone); else the part keeps its heading and charts
//      and its prose becomes a fixed sentence. Every section says when it was written, from the data then.
//   3. the run records the story id, under the run's row lock: a second press (even a concurrent one) opens the same story.

import { randomUUID } from 'crypto';
import { computeCard } from '../../ipc/answers';
import { saveCardAsVisual } from '../../ipc/answerSave';
import { addTile } from '../../ipc/drivers';
import * as stories from '../../analysis/stories';
import { sanitizeStoredSpec } from '../../ai/answerSpec';
import { sanitizeDriversSpec } from '../../analysis/driverScope';
import { storyBlocks, type Block } from '../../ai/researchWrite';
import { formatDate } from '../../app/format';
import { restricted } from '../slack/check';
import * as store from './db';
import * as say from '../researchMessages';

export type Added = { ok: true; storyId: string; created: boolean } | { ok: false; error: string };

export async function addToProject(org: string, runId: string): Promise<Added> {
  const out = await store.withRunLocked(org, runId, async (run, setStory): Promise<Added> => {
    if (run.storyId) return { ok: true, storyId: run.storyId, created: false };
    const report = run.report;
    if (!report || !['done', 'partial'].includes(run.state)) return { ok: false, error: say.noReport() };
    const byN = new Map(run.steps.map((s) => [s.n, s]));
    const nameOf = (heading: string): string => `${report.title || run.question.slice(0, 80)} · ${heading || report.title}`.slice(0, 200);

    // 1. The charts, in the order the report cites them (the first section to cite a step names its chart).
    const visualOf = new Map<number, string>();
    const extra: string[] = [];
    for (const section of report.sections) {
      for (const n of section.steps) {
        const step = byN.get(n);
        if (!step || step.status !== 'done' || visualOf.has(n)) continue;
        const name = nameOf(section.heading);
        try {
          if (step.kind === 'answer') {
            const spec = sanitizeStoredSpec(step.spec);
            const built = spec ? await computeCard(run.projectId, spec) : null;
            if (built && 'card' in built) {
              const saved = await saveCardAsVisual(run.projectId, { ...built.card, title: name });
              if (saved.ok) visualOf.set(n, saved.visual.id);
            }
          } else if (step.kind === 'drivers') {
            const spec = sanitizeDriversSpec(step.spec, (step.spec as { filters?: never[] } | undefined)?.filters ?? []);
            const saved = spec ? await addTile(run.projectId, spec, name) : null;
            if (saved?.ok) visualOf.set(n, (saved.visual as { id: string }).id);
          } else {
            extra.push(say.sqlNotSaved(String(n)));
            continue;
          }
        } catch {
          // a chart that cannot be saved is left out with a line, never the whole report
        }
        if (!visualOf.has(n)) extra.push(say.chartNotSaved(String(n)));
      }
    }

    // 2. The Story. Restricted per section over its cited steps, and over every cited step for the summary and conclusion.
    const idsOf = (ns: readonly number[]): string[] => [...new Set(ns.flatMap((n) => byN.get(n)?.datasetIds ?? []))];
    const flags = {
      sections: await Promise.all(report.sections.map((s) => restricted({ projectId: run.projectId, datasetIds: idsOf(s.steps), dashboardIds: [] }))),
      all: await restricted({ projectId: run.projectId, datasetIds: idsOf(report.sections.flatMap((s) => s.steps)), dashboardIds: [] }),
    };
    const blocks = storyBlocks(report, flags, { fixed: say.restrictedProse(), written: say.writtenOn(formatDate(report.writtenAt.slice(0, 10))) }, new Set(visualOf.keys()), extra);
    const story = await stories.saveStory(run.projectId, { name: report.title || run.question.slice(0, 120), blocks: blocks.map((b) => asBlock(b, visualOf)) });
    if (!story) return { ok: false, error: say.couldNotAdd() };
    await setStory(story.id);
    return { ok: true, storyId: story.id, created: true };
  });
  return out ?? { ok: false, error: say.notFound() };
}

const asBlock = (b: Block, visualOf: ReadonlyMap<number, string>): Record<string, unknown> => {
  const id = randomUUID();
  switch (b.kind) {
    case 'visual': return { id, kind: 'visual', visualId: visualOf.get(b.stepN), filters: [] };
    case 'callout': return { id, kind: 'callout', tone: b.tone, text: b.text };
    case 'divider': return { id, kind: 'divider' };
    default: return { id, kind: 'text', text: b.text };
  }
};
