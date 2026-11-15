// Who a mention on one target may name and tell (docs/team-folders/00-design.md D17, "Pushes, mentions and
// recipients"): the project's current readers (./people.ts) who can also open the target — its dataset, its
// dashboard, or for a story every dataset and dashboard it shows. A mention of anyone else is refused as a
// non-reader's is, and a notice goes to no one else. With no folder besides Everyone every anchor is Everyone, so
// the set is exactly the project's readers.

import type { CommentTarget } from '../../app/commentModel';
import type { PlacedKind } from '../authz/folders';
import { openers } from '../authz/folderGate';
import { ctx } from '../context';
import { orgDb } from '../db/inOrg';
import { normalize } from '../../app/mentionToken';
import { refsIn } from '../../analysis/followsOpen';
import * as metrics from '../../analysis/metrics';
import * as stories from '../../analysis/stories';
import * as visuals from '../../analysis/visuals';
import { currentReaders } from './people';

type Anchor = { kind: PlacedKind; id: string };

/** What `target`'s access follows, read through the caller's stores (a target they cannot see names nothing: their write is refused first). */
async function anchorsOf(projectId: string, target: Pick<CommentTarget, 'kind' | 'id'>): Promise<Anchor[]> {
  const ofDataset = (id: string | null | undefined): Anchor[] => (id ? [{ kind: 'dataset', id }] : []);
  if (target.kind === 'dataset') return ofDataset(target.id);
  if (target.kind === 'analysis') return [{ kind: 'dashboard', id: target.id }];
  if (target.kind === 'visual') return ofDataset((await visuals.getVisual(projectId, target.id))?.datasetId);
  if (target.kind === 'card') {
    const { targetNames } = require('../../ipc/comments') as typeof import('../../ipc/comments'); // lazy: that module starts the notices
    const on = (await targetNames(projectId, [{ target } as never]))[`card:${target.id}`]?.analysisId;
    return on ? [{ kind: 'dashboard', id: on }] : [];
  }
  const story = await stories.getStory(projectId, target.id);
  const out: Anchor[] = [];
  for (const [ref, id] of (story && refsIn(story)) || []) {
    if (ref === 'dataset' || ref === 'dashboard') out.push({ kind: ref, id });
    else if (ref === 'visual') out.push(...ofDataset((await visuals.getVisual(projectId, id))?.datasetId));
    else if (ref === 'metric') out.push(...ofDataset((await metrics.getMetric(projectId, id))?.datasetId));
  }
  return out;
}

/** The project's current readers who open `target` (normalised addresses), or null without a database. */
export async function targetReaders(projectId: string, target: Pick<CommentTarget, 'kind' | 'id'>): Promise<Set<string> | null> {
  const readers = await currentReaders(projectId);
  const pool = orgDb();
  if (!readers || !pool) return readers;
  const seen = new Set<string>();
  for (const a of await anchorsOf(projectId, target)) {
    if (seen.has(`${a.kind}:${a.id}`)) continue;
    seen.add(`${a.kind}:${a.id}`);
    const open = new Set((await openers(pool, ctx().org.id, projectId, a, 'view')).map(normalize));
    for (const r of readers) if (!open.has(r)) readers.delete(r);
  }
  return readers;
}
