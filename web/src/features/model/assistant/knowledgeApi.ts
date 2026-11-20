// Knowledge documents (`knowledge:list`, `knowledge:get`, `knowledge:save`, `knowledge:upload`, `knowledge:delete`;
// src/ipc/knowledge.ts): reference text the Assistant reads, for the project or for one agent. Contracts carry inputs
// only, so the replies are narrowed here by hand. The server decides who may read and change; this only formats.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RpcError, rpc, upload } from '../../../api/client';
import type { Fail } from '../../data/api';

export type DocSource = 'typed' | 'markdown' | 'text' | 'pdf' | 'docx';

export interface DocRow {
  id: string;
  agentId: string | null;
  title: string;
  source: DocSource;
  fileName: string | null;
  chars: number;
  updatedBy: string;
  updatedAt: string;
}
export interface DocFull extends DocRow { text: string; tag: string }

export interface DocList {
  docs: DocRow[];
  total: number;
  max: number;
  /** For an agent's list: how many documents the project holds (they apply to the agent too). */
  projectDocs: number | null;
  canEdit: boolean;
}

/** `needsDatabase`: the server runs without Postgres, where documents are off. */
export class DocsOff extends Error {}

type Refused = Fail & { needsDatabase?: true };
export const docsKey = (projectId: string, agentId?: string) => ['knowledge:list', projectId, agentId ?? ''] as const;

export const useDocs = (projectId: string, agentId?: string) =>
  useQuery({
    queryKey: docsKey(projectId, agentId),
    queryFn: async (): Promise<DocList> => {
      const r = (await rpc('knowledge:list', { projectId, ...(agentId ? { agentId } : {}) })) as ({ ok: true } & DocList) | Refused;
      if (!r.ok) throw (r as Refused).needsDatabase ? new DocsOff(r.error) : new Error(r.error || 'The documents could not be read.');
      return r;
    },
  });

/** One document with its text, read when its dialog opens. */
export const useDoc = (projectId: string, id: string | null) =>
  useQuery({
    queryKey: ['knowledge:get', projectId, id],
    enabled: id !== null,
    gcTime: 0,
    queryFn: async (): Promise<DocFull> => {
      const r = (await rpc('knowledge:get', { projectId, id: id as string })) as { ok: true; doc: DocFull } | Fail;
      if (!r.ok) throw new Error(r.error || 'The document could not be read.');
      return r.doc;
    },
  });

export type SaveResult = { ok: true; doc: DocFull } | { ok: false; error: string; changed?: true };

/** Create (no `id`) or edit. Resolves to the server's refusal sentence; a stale tag is `changed`. */
export function useSaveDoc(projectId: string, agentId?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id?: string; base?: string; title: string; text: string }): Promise<SaveResult> => {
      let r: { ok: true; doc: DocFull } | Refused;
      try {
        r = (await rpc('knowledge:save', { projectId, ...(agentId && !v.id ? { agentId } : {}), ...(v.id ? { id: v.id } : {}), ...(v.base ? { base: v.base } : {}), title: v.title, text: v.text })) as typeof r;
      } catch (err) {
        if (err instanceof RpcError && err.status === 409) return { ok: false, error: err.message, changed: true };
        return { ok: false, error: 'The document could not be saved.' };
      }
      if (!r.ok) return { ok: false, error: r.error || 'The document could not be saved.' };
      await client.invalidateQueries({ queryKey: ['knowledge:list', projectId] });
      return r;
    },
  });
}

export function useDeleteDoc(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<string | null> => {
      try {
        const r = (await rpc('knowledge:delete', { projectId, id })) as { ok: true } | Refused;
        if (!r.ok) return r.error || 'The document could not be removed.';
      } catch {
        return 'The document could not be removed.';
      }
      await client.invalidateQueries({ queryKey: ['knowledge:list', projectId] });
      return null;
    },
  });
}

/** Stage the file (`POST /api/files`), then have the server read it in its worker. Resolves to the sentence to show, or null. */
export function useUploadDoc(projectId: string, agentId?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<string | null> => {
      try {
        const up = await upload(file, file.name);
        const r = (await rpc('knowledge:upload', { projectId, ...(agentId ? { agentId } : {}), fileToken: up.fileToken })) as { ok: true } | Refused;
        if (!r.ok) return r.error || 'This file could not be read.';
      } catch (err) {
        return err instanceof RpcError ? err.message : 'This file could not be uploaded.';
      }
      await client.invalidateQueries({ queryKey: ['knowledge:list', projectId] });
      return null;
    },
  });
}

export const SOURCE_LABEL: Record<DocSource, string> = { typed: 'Typed', markdown: 'Markdown', text: 'Text', pdf: 'PDF', docx: 'Word' };
