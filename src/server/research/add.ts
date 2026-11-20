// "Add to project" (docs/deep-research/00-design.md, "The report"), as the starter, idempotent:
//   1. each cited chart is saved through the path the dock's Save uses: an answer step as `answer:saveVisual` does (computeCard,
//      saveCardAsVisual: it lands with its dataset under the team-folder rules), a drivers step as `drivers:addTile` does. An SQL
//      step has no saved-chart path, so it stays out, with a caveat line. A store's refusal drops that chart with a caveat line.
//   2. the Story, under the question-5 rule decided for the WHOLE RUN (../../ai/researchWrite `storyBlocks`): when any computed step
//      touched data `restricted()` calls restricted (row rules, column rules, a folder not open to everyone), no model sentence is
//      kept (the summary, conclusion, every section's text and the caveats are fixed lines; a heading or title with a digit is
//      replaced); an open run keeps its prose as written, every section dated.
//   3. the run records the story id once.
// THE WORK IS DONE OUTSIDE ANY ROW LOCK (no pooled connection is held while a chart is computed or a story saved): a short lease
// (`claimAdd`) lets one press work at a time, the visual saved for each step is written on the run as it is saved (a retry after a
// failure reuses it, saving none twice), and `finalizeStory` sets story_id only for the lease's holder and only while there is none.

import { randomUUID } from 'crypto';
import { computeCard } from '../../ipc/answers';
import { saveCardAsVisual } from '../../ipc/answerSave';
import { addTile } from '../../ipc/drivers';
import * as stories from '../../analysis/stories';
import * as visuals from '../../analysis/visuals';
import { sanitizeStoredSpec } from '../../ai/answerSpec';
import { sanitizeDriversSpec } from '../../analysis/driverScope';
import { sectionHeading, storyBlocks, storyTitle, type Block, type Words } from '../../ai/researchWrite';
import { formatDate } from '../../app/format';
import { restricted } from '../slack/check';
import * as datasets from '../../data/datasets';
import * as store from './db';
import * as say from '../researchMessages';

export type Added = { ok: true; storyId: string; created: boolean } | { ok: false; error: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const WAIT_MS = 250;
const WAIT_TURNS = 120;

export async function addToProject(org: string, runId: string): Promise<Added> {
  const first = await store.getRun(org, runId);
  if (!first) return { ok: false, error: say.notFound() };
  if (first.storyId) return { ok: true, storyId: first.storyId, created: false };
  if (!first.report || store.ACTIVE.includes(first.state)) return { ok: false, error: say.noReport() };
  const token = randomUUID();
  let held = await store.claimAdd(org, runId, token);
  // Another press holds the lease: wait for it to finish (then this one opens the same story) or for its lease to lapse (then this one works).
  for (let i = 0; held && 'busy' in held && i < WAIT_TURNS; i += 1) {
    await sleep(WAIT_MS);
    held = await store.claimAdd(org, runId, token);
  }
  if (!held) return { ok: false, error: say.notFound() };
  if ('story' in held) return { ok: true, storyId: held.story, created: false };
  if ('busy' in held) return { ok: false, error: say.couldNotAdd() };
  const made: string[] = []; // visuals THIS press saved (never one an earlier try recorded)
  try {
    return await work(org, runId, token, held.visuals, made);
  } catch {
    await store.releaseAdd(org, runId, token).catch(() => undefined); // the visuals recorded so far stay on the run: a retry reuses them
    await dropUnrecorded(org, runId, first.projectId, made); // one a lost lease left unrecorded would be an orphan
    return { ok: false, error: say.couldNotAdd() };
  }
}

/** Deletes what this press saved and the run does not record now (a later holder reuses the recorded ones; after a Resume none is recorded). */
async function dropUnrecorded(org: string, runId: string, projectId: string, made: readonly string[]): Promise<void> {
  const keep = new Set(await store.addVisualsOf(org, runId).catch(() => [] as string[]));
  for (const id of made) if (!keep.has(id)) await visuals.deleteVisual(projectId, id).catch(() => undefined);
}

async function work(org: string, runId: string, token: string, saved: Record<string, string>, made: string[]): Promise<Added> {
  const run = await store.getRun(org, runId);
  const report = run?.report;
  if (!run || !report) { await store.releaseAdd(org, runId, token); return { ok: false, error: say.noReport() }; }
  const byN = new Map(run.steps.map((s) => [s.n, s]));
  const words: Words = {
    fixed: say.restrictedProse(), fixedCaveats: say.restrictedCaveats(), written: say.writtenOn(formatDate(report.writtenAt.slice(0, 10))), finding: (n) => say.findingTitle(String(n)),
  };

  // The rule is the whole run's: every COMPUTED step, cited or not.
  // FAIL CLOSED: restricted when a step read restricted data when it ran (recorded then), when its data is restricted now, or when a dataset
  // it read is gone (restricted() reads a deleted dataset as open, so its record is checked first).
  const ids = [...new Set(run.steps.flatMap((s) => (s.status === 'done' ? s.datasetIds ?? [] : [])))];
  const gone = (await Promise.all(ids.map(async (id) => !(await datasets.getDatasetMeta(run.projectId, id))))).some(Boolean);
  const closed = run.restricted || gone || (await restricted({ projectId: run.projectId, datasetIds: ids, dashboardIds: [] }));
  const title = storyTitle(report, run.question, closed);

  // 1. The charts, in the order the report cites them (the first section to cite a step names its chart).
  const visualOf = new Map<number, string>();
  const reused = new Set<number>();
  const extra: string[] = [];
  for (const [si, section] of report.sections.entries()) {
    for (const n of section.steps) {
      const step = byN.get(n);
      if (!step || step.status !== 'done' || visualOf.has(n)) continue;
      const kept = saved[String(n)];
      if (kept && (await visuals.getVisual(run.projectId, kept))) { visualOf.set(n, kept); reused.add(n); continue; } // saved by an earlier try
      const name = `${title} · ${sectionHeading(section.heading, si, closed, words) || title}`.slice(0, 200);
      try {
        if (step.kind === 'answer') {
          const spec = sanitizeStoredSpec(step.spec);
          const built = spec ? await computeCard(run.projectId, spec) : null;
          if (built && 'card' in built) {
            const r = await saveCardAsVisual(run.projectId, { ...built.card, title: name });
            if (r.ok) visualOf.set(n, r.visual.id);
          }
        } else if (step.kind === 'drivers') {
          const spec = sanitizeDriversSpec(step.spec, (step.spec as { filters?: never[] } | undefined)?.filters ?? []);
          const r = spec ? await addTile(run.projectId, spec, name) : null;
          if (r?.ok) visualOf.set(n, (r.visual as { id: string }).id);
        } else {
          extra.push(say.sqlNotSaved(String(n)));
          continue;
        }
      } catch {
        // a chart that cannot be saved is left out with a line, never the whole report
      }
      const id = visualOf.get(n);
      if (!id) extra.push(say.chartNotSaved(String(n)));
      else if (!(await store.recordVisual(org, runId, token, n, id))) {
        made.push(id);
        throw new Error('the add lease was lost'); // the catch below deletes what this press made and nobody recorded
      }
      else if (!reused.has(n)) made.push(id);
    }
  }

  // 2. The Story.
  const blocks = storyBlocks(report, run.question, closed, words, new Set(visualOf.keys()), extra);
  if (!(await store.renewAdd(org, runId, token))) throw new Error('the add lease was lost'); // the charts took time: keep the lease through the story
  const story = await stories.saveStory(run.projectId, { name: title || run.question.slice(0, 120), blocks: blocks.map((b) => asBlock(b, visualOf)) });
  if (!story) return { ok: false, error: say.couldNotAdd() };

  // 3. Recorded once. A press that lost its lease (it lapsed, or a Resume cleared it) drops its own Story and the charts nobody recorded,
  // whether another press finished (its story id) or none did yet (null).
  const final = await store.finalizeStory(org, runId, token, story.id);
  if (final !== story.id) {
    await stories.deleteStory(run.projectId, story.id).catch(() => undefined);
    await dropUnrecorded(org, runId, run.projectId, made);
    return final ? { ok: true, storyId: final, created: false } : { ok: false, error: say.couldNotAdd() };
  }
  return { ok: true, storyId: final, created: true };
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
