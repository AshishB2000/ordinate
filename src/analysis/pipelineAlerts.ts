// The alert a failed pipeline run raises carries the run's error in its message (src/app/pipelineRunner.raiseFailures).
// For a dataset copied from a connection that error is the warehouse driver's, which quotes the relation it could not
// find (docs/semantic-layer/02-source-tables.md, D13): a reader who may not see source names gets a fixed sentence.

import type { AlertEvent } from './alerts';
import { refreshFailedForViewer } from '../data/refreshMessages';

/** raiseFailures gives its event the dataset's own id as `ruleId`; a rule's alert has a rule id of its own. */
const isRunFailure = (e: AlertEvent): boolean => e.ruleName === 'Pipeline' && e.ruleId === e.datasetId;

/** `events` with the run error replaced by a fixed sentence on every run failure of a dataset in `ids(projectId)`. Reads the datasets only if there is one. */
export async function withoutRunError(projectId: string, events: AlertEvent[], ids: (projectId: string) => Promise<ReadonlySet<string>>): Promise<AlertEvent[]> {
  if (!events.some(isRunFailure)) return events;
  const hidden = await ids(projectId);
  return events.map((e) => (isRunFailure(e) && hidden.has(e.datasetId) ? { ...e, message: refreshFailedForViewer() } : e));
}
