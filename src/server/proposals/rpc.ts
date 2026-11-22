// Metric proposals over RPC (src/api/proposals.ts; ./proposals.ts). A FolderError (a dataset the reviewer cannot edit)
// is thrown on: the route answers it 409 `folder`.

import { registry } from '../rpc';
import { approveProposal, declineProposal, listProposals, proposeFromTurn, type Edit } from './proposals';

export function register(): void {
  registry.handle('proposal:propose', (_e, { projectId, threadId, turnId }: { projectId: string; threadId: string; turnId: string }) => proposeFromTurn(projectId, threadId, turnId));
  registry.handle('proposal:list', (_e, { projectId, decided }: { projectId: string; decided: boolean }) => listProposals(projectId, decided === true));
  registry.handle('proposal:approve', (_e, { projectId, id, edit }: { projectId: string; id: string; edit?: Edit }) => approveProposal(projectId, id, edit));
  registry.handle('proposal:decline', (_e, { projectId, id, note }: { projectId: string; id: string; note: string }) => declineProposal(projectId, id, note));
}
