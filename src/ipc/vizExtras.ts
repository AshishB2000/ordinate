// The `visual:data` answers the single-dataset path cannot give — a visual
// reaching across relationships. `ipc/visuals.vizDataFor` asks here FIRST; a
// null means "not mine", and its own path runs unchanged.

import type { FilterStep } from '../data/transforms';
import type { VizEncoding } from '../analysis/visuals';
import { joinedVizDataFor } from './relationships';

export async function authoringVizData(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  // ponytail: the `visual:data` reply envelope (VizDataReply in ipc/visuals.ts), or null
): Promise<any> {
  return joinedVizDataFor(projectId, datasetId, encoding, filters);
}
