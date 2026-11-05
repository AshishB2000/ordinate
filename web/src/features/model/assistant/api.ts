// The project's Assistant instructions (`catalog:instructions`, `catalog:setInstructions`; src/app/instructions.ts).
// One change per call, so two editors never lose each other's edit; the server stamps who and when and flags a
// figure-like token. Contracts carry inputs only, so the replies are narrowed here by hand.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { okOr, type Fail } from '../../data/api';

export interface Instruction {
  id: string;
  text: string;
  updatedBy: string;
  updatedAt: string;
  /** A figure-like token: the editor warns "Figures belong in metrics", never refuses. */
  figure?: true;
}

export type InstructionOp = { kind: 'add'; text: string } | { kind: 'edit'; id: string; text: string } | { kind: 'remove'; id: string };
type Reply = { ok: true; instructions: Instruction[] } | Fail;

const READ = 'catalog:instructions';
const keyOf = (projectId: string) => [READ, projectId] as const;

export const useInstructions = (projectId: string) =>
  useQuery({
    queryKey: keyOf(projectId),
    queryFn: async () => okOr((await rpc(READ, { projectId })) as Reply, 'The instructions').instructions,
  });

/** One op; resolves to the server's refusal sentence, or null once it is stored (and the list is read again). */
export function useChangeInstruction(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (op: InstructionOp): Promise<string | null> => {
      let r: Reply;
      try {
        r = (await rpc('catalog:setInstructions', { projectId, op })) as Reply;
      } catch {
        return 'Could not save the instruction.';
      }
      if (!r.ok) return r.error || 'Could not save the instruction.';
      await client.invalidateQueries({ queryKey: keyOf(projectId) });
      return null;
    },
  });
}

// ── Verified questions (`verified:list`, `verified:save`, `verified:delete`; src/ipc/verified.ts) ──────────

/** One question as the server words it for this caller. `spec` is absent when row access rules hide its values. */
export interface VerifiedRow {
  id: string;
  question: string;
  phrasings: string[];
  note?: string;
  datasetId: string;
  datasetName: string;
  describe: string;
  filters: string[];
  spec?: { datasetId: string } & Record<string, unknown>;
  verifiedBy: string;
  verifiedAt: string;
  runs: boolean;
  problem?: string;
  tag: string;
}
export type VerifiedField = 'question' | 'phrasings' | 'spec';
type ListReply = { ok: true; broken: number; questions: VerifiedRow[] } | Fail;

export const verifiedKey = (projectId: string, datasetId?: string) => ['verified:list', projectId, datasetId ?? ''] as const;

export const useVerified = (projectId: string, datasetId?: string, opts: { enabled?: boolean; retry?: boolean } = {}) =>
  useQuery({
    queryKey: verifiedKey(projectId, datasetId),
    ...opts,
    queryFn: async () => {
      const r = okOr((await rpc('verified:list', { projectId, ...(datasetId ? { datasetId } : {}) })) as ListReply, 'The verified questions');
      return { broken: r.broken, questions: r.questions };
    },
  });
