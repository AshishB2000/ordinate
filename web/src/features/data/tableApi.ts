// The About tab's calls: a dataset's role, key, grain and guide (src/ipc/tableDocs.ts,
// src/app/tableDocs.ts). Contracts carry inputs only, so each reply is narrowed here by
// hand. The key check's counts are the server's, counted over every row: the screen only
// formats them. A caller row access rules restrict gets the doc without `keyCheck`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';
import { okOr, useWrite, type Fail, type Relationship } from './api';

/** Counted over the whole table when the key was last checked (src/app/tableDocs.ts KeyCheck). */
export interface KeyCheck {
  rows: number;
  empty: number;
  /** Distinct non-empty keys seen on two or more rows. */
  repeatedKeys: number;
  checkedAt: string;
}

export type TableRole = '' | 'fact' | 'dimension';

/** src/app/tableDocs.ts TableDoc. */
export interface TableDoc {
  role: TableRole;
  /** One column name, matched exactly. '' = none. */
  key: string;
  grain: string;
  guide: string;
  keyCheck?: KeyCheck;
  updatedBy: string;
  updatedAt: string;
}

export type TablePatch = RpcInput<'catalog:setTable'>['patch'];

const READ = 'catalog:getTable';

export const useTableDoc = (projectId: string, datasetId: string) =>
  useQuery({
    queryKey: [READ, projectId, datasetId],
    queryFn: async () => okOr((await rpc(READ, { projectId, datasetId })) as { ok: true; table: TableDoc } | Fail, 'The table notes').table,
  });

/** A write's reply: the doc as the server stored it, or its sentence (a Live refusal also carries a `code`). */
export type TableReply = { ok: true; table: TableDoc } | { ok: false; error?: string; code?: string };

/**
 * Save a field (`save`) or count the key now (`check`). A reply puts the stored doc straight into the read, so
 * the screen shows what the SERVER kept (a trimmed grain, a count), and a refusal is the caller's to say at the field.
 * `check` changes nothing, so a call that throws is the caller's to word too: it has no "the change did not go through" toast.
 */
export function useTableWrites(projectId: string, datasetId: string) {
  const client = useQueryClient();
  const keep = (r: TableReply) => {
    if (r.ok) client.setQueryData([READ, projectId, datasetId], r.table);
  };
  // A new key rewrites the warnings on the relationships into this table; counting it again does not. The Data model's
  // overview (what to fill in next) reads the same doc.
  const save = useWrite<'catalog:setTable', TableReply>('catalog:setTable', [READ, 'relationship:list', 'model:overview', 'model:navigation'], { quiet: true, onDone: keep });
  const check = useMutation({
    mutationFn: async () => (await rpc('catalog:checkKey', { projectId, datasetId })) as TableReply,
    onSuccess: (r) => {
      keep(r);
      void client.invalidateQueries({ queryKey: [READ] });
      void client.invalidateQueries({ queryKey: ['model:overview'] });
    },
  });
  return { save, check };
}

/** "Customers'" / "Region's". */
const possessive = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** The line under a relationship whose lookup side is not a clean "one" ('' when it is). `toName` is the lookup dataset's name. */
export function relWarningText(r: Relationship, toName: string): string {
  const w = r.warning;
  if (!w) return '';
  if (w.kind === 'repeats') return `${toName} repeats some ${r.to.column} values. Each lookup uses the first matching row.`;
  return `${possessive(toName)} key is ${w.key}; this relationship looks rows up by ${r.to.column}.`;
}
