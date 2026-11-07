// The Data model's second read (`model:navigation`, src/ipc/modelNavigation.ts): every dataset's drill hierarchies
// (a level that is no longer a text column is marked `missing`) and the calendar's date ladder. Names only, never a
// value. The ladder rules are the server's own pure file, imported as figureAsk.ts is.

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { okOr, type Fail } from '../data/api';
import type { NavHierarchy } from '../../../../src/analysis/drillLevels.ts';
import type { DateGrain } from '../../../../src/analysis/categoryKey.ts';

export type { NavHierarchy };

/** A topic as every reader gets it (step 07, src/ipc/modelNavigation.ts NavTopic): gone members left out, in its order. */
export interface NavTopic {
  id: string;
  name: string;
  description?: string;
  /** No `fields`: every field. */
  datasets: { id: string; fields?: string[] }[];
  metricIds: string[];
  termIds: string[];
}

export interface Navigation {
  ok: true;
  tables: { datasetId: string; hierarchies: NavHierarchy[] }[];
  dateLadder: DateGrain[];
  /** Absent from a pod before step 07: no topics. */
  topics?: NavTopic[];
}

export const NAVIGATION = 'model:navigation';

const read = async (projectId: string) => okOr((await rpc(NAVIGATION, { projectId })) as Navigation | Fail, 'The hierarchies');

export const useNavigation = (projectId: string, enabled = true) =>
  useQuery({ queryKey: [NAVIGATION, projectId], queryFn: () => read(projectId), staleTime: 60_000, enabled });

/** One dataset's hierarchies, in the order the server stored them. */
export const navFor = (nav: Navigation | undefined, datasetId: string): NavHierarchy[] => nav?.tables.find((t) => t.datasetId === datasetId)?.hierarchies ?? [];

/** The reply, or null on any failure: a caller then draws the screen it had before hierarchies. */
export async function loadNavigation(qc: QueryClient, projectId: string): Promise<Navigation | null> {
  try {
    return await qc.fetchQuery({ queryKey: [NAVIGATION, projectId], queryFn: () => read(projectId), staleTime: 60_000 });
  } catch {
    return null;
  }
}
