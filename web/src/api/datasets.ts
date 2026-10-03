import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from './client';

/**
 * What `dataset:list` returns per dataset — the fields the web reads, mirrored
 * from src/data/datasetSummary.ts `DatasetSummary` (narrowed by hand for the
 * same reason as `Project` in ./projects.ts).
 */
export interface DatasetSummary {
  id: string;
  name: string;
  sourceKind: string;
  rowCount: number;
  columnCount: number;
  updatedAt: string;
}

/** The project's saved datasets; idle until a project is chosen. */
export function useDatasets(projectId: string | undefined) {
  return useQuery({
    queryKey: ['dataset:list', projectId],
    queryFn: projectId === undefined ? skipToken : async () => (await rpc('dataset:list', { projectId })) as DatasetSummary[],
  });
}
