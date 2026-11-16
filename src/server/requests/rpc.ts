// Dashboard requests over RPC (src/api/requests.ts; ./requests.ts). The bell's rows ride on `mentions:list`
// (../mentions/rpc.ts). A FolderError (a dataset closed to the caller, or one they only view) is thrown on: the route
// answers it 409 `folder`.

import { registry } from '../rpc';
import { approveRequest, createRequest, declineRequest, previewRequest } from './requests';

export function register(): void {
  registry.handle('request:create', (_e, input: { projectId: string; threadId: string; turnIds: string[]; title: string; note?: string }) => createRequest(input.projectId, input));
  registry.handle('request:preview', (_e, { projectId, id }: { projectId: string; id: string }) => previewRequest(projectId, id));
  registry.handle('request:approve', (_e, { projectId, id, publish }: { projectId: string; id: string; publish: boolean }) => approveRequest(projectId, id, publish === true));
  registry.handle('request:decline', (_e, { projectId, id, note }: { projectId: string; id: string; note: string }) => declineRequest(projectId, id, note));
}
