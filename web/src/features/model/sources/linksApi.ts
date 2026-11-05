// The calls behind a source table's Lineage and a dataset's source notes (src/ipc/sourceTableLinks.ts).
// Every channel is `write`; the web asks them for an editor only. Replies are narrowed here by hand.

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { okOr, type Fail } from '../../data/api';
import type { Lineage } from '../../data/api';
import { LIST } from './api';

export const LINEAGE = 'sourceTable:lineage';
export const FOR_DATASET = 'sourceTable:forDataset';
export const CHOICES = 'dataset:sourceTableChoices';

/** One source table as a dataset's Guide shows it (SourceBlock in the server file). A block with no `docId` has empty strings. */
export interface SourceBlock {
  connId: string;
  connName: string;
  table: string;
  docId?: string;
  owner: string;
  refresh: string;
  requiredFilters: string;
  guide: string;
  primaryKey?: { columns: string[]; enforced: boolean };
  partition?: { columns: string[]; method?: string; required?: boolean };
  updatedBy?: string;
  updatedAt?: string;
}
export interface SourceBlocks {
  ok: true;
  /** The dataset is built from a connection, so its tables can be named. */
  linkable: boolean;
  /** It runs a query, so its tables are the ones an editor linked. */
  byQuery: boolean;
  tables: SourceBlock[];
}

export const useSourceLineage = (projectId: string, connId: string, docId: string) =>
  useQuery({
    queryKey: [LINEAGE, projectId, connId, docId],
    queryFn: async () => okOr((await rpc(LINEAGE, { projectId, connId, docId })) as ({ ok: true } & Lineage) | Fail, 'The lineage'),
  });

/** An editor's Guide only: the caller passes `on` from `useCanEdit`, so a viewer's web never asks. */
export const useSourceBlocks = (projectId: string, datasetId: string, on: boolean) =>
  useQuery({
    queryKey: [FOR_DATASET, projectId, datasetId],
    queryFn: on ? async () => okOr((await rpc(FOR_DATASET, { projectId, datasetId })) as SourceBlocks | Fail, 'The source notes') : skipToken,
  });

/** The link picker's list: a warehouse call, so it runs only while the dialog is open. */
export const useSourceChoices = (projectId: string, datasetId: string) =>
  useQuery({
    queryKey: [CHOICES, projectId, datasetId],
    queryFn: async () => okOr((await rpc(CHOICES, { projectId, datasetId })) as { ok: true; tables: string[]; linked: string[] } | Fail, 'The tables'),
    gcTime: 0,
    staleTime: 0,
  });

export function useSetSourceTables(projectId: string, datasetId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (tables: string[]) => {
      const r = (await rpc('dataset:setSourceTables', { projectId, datasetId, tables })) as { ok: true; tables: string[] } | Fail;
      if (!r.ok) throw new Error(r.error || 'The tables could not be linked.');
      return r.tables;
    },
    onSuccess: () => Promise.all([FOR_DATASET, LIST, LINEAGE].map((k) => client.invalidateQueries({ queryKey: [k] }))),
  });
}
