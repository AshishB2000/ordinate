// The Data model's one read for its Datasets tab (`model:overview`, src/ipc/modelOverview.ts): every
// dataset's role, key state, description, always-applied filters and calculated fields, and the
// server's ranked "To fill in next" list. Contracts carry inputs only, so the reply is narrowed here
// by hand. Every count in it is the server's; this only words it.

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { okOr, type Fail } from '../data/api';
import { formatNumber } from '../data/format';
import type { TableRole } from '../data/tableApi';
import type { FilterStep } from '../visuals/api';

/** A gap, by rank (src/ipc/modelOverview.ts TodoKind). */
export type TodoKind = 'key_repeats' | 'no_key' | 'no_guide' | 'no_description' | 'no_role';
export interface TodoItem {
  datasetId: string;
  kind: TodoKind;
  /** key_repeats only: how many key values repeat, counted by the server. */
  repeats?: number;
}

export interface ModelTable {
  datasetId: string;
  role: TableRole;
  key: string;
  /** '' = no key; unchecked = never counted, or the count is hidden from this caller. */
  keyState: '' | 'unchecked' | 'unique' | 'repeats';
  description: string;
  alwaysApplied: { kind: 'prepare' | 'live'; steps: FilterStep[] };
  calculated: { name: string; formula: string }[];
  /** Row access rules: each step is its column and operator only, each formula ''. */
  valuesHidden?: true;
}

export interface ModelOverview {
  ok: true;
  tables: ModelTable[];
  todo: TodoItem[];
  more: number;
}

export const OVERVIEW = 'model:overview';

export const useModelOverview = (projectId: string) =>
  useQuery({
    queryKey: [OVERVIEW, projectId],
    queryFn: async () => okOr((await rpc(OVERVIEW, { projectId })) as ModelOverview | Fail, 'The data model'),
  });

/** One strip item in words: "Orders: 12 keys repeat", "Set a key on Orders". */
export function todoText(item: TodoItem, name: string): string {
  switch (item.kind) {
    case 'key_repeats': {
      const n = item.repeats ?? 0;
      return `${name}: ${formatNumber(n)} ${n === 1 ? 'key repeats' : 'keys repeat'}`;
    }
    case 'no_key':
      return `Set a key on ${name}`;
    case 'no_guide':
      return `Write a guide for ${name}`;
    case 'no_description':
      return `Describe ${name}`;
    case 'no_role':
      return `Set a role for ${name}`;
  }
}

/** The panel tab a strip item opens: the guide for a missing guide, the overview for the rest. */
export const todoPanel = (kind: TodoKind): 'overview' | 'guide' => (kind === 'no_guide' ? 'guide' : 'overview');
