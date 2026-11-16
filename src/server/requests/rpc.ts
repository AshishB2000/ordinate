// Dashboard requests over RPC (src/api/requests.ts; ./requests.ts). The bell's rows ride on `mentions:list`
// (../mentions/rpc.ts). A FolderError (a dataset closed to the caller, or one they only view) is thrown on: the route
// answers it 409 `folder`.

import { registry } from '../rpc';
import { approveRequest, createRequest, declineRequest, previewRequest, requestFolders, withdrawRequest, type CreateInput } from './requests';

export function register(): void {
  registry.handle('request:create', (_e, input: CreateInput & { projectId: string }) => createRequest(input.projectId, input));
  registry.handle('request:withdraw', (_e, { projectId, id }: { projectId: string; id: string }) => withdrawRequest(projectId, id));
  registry.handle('request:folders', (_e, { projectId }: { projectId: string }) => requestFolders(projectId));
  registry.handle('request:preview', (_e, { projectId, id }: { projectId: string; id: string }) => previewRequest(projectId, id));
  registry.handle('request:approve', (_e, { projectId, id, publish, folderId }: { projectId: string; id: string; publish: boolean; folderId?: string }) => approveRequest(projectId, id, publish === true, folderId));
  registry.handle('request:decline', (_e, { projectId, id, note }: { projectId: string; id: string; note: string }) => declineRequest(projectId, id, note));
}
