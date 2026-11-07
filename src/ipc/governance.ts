// Certified and retired status, managed (semantic layer part 4, D3) — MAIN PROCESS. Project ADMIN channels
// (src/api/governance.ts); the store is ../analysis/statusStore.ts.
//
//   model:review       the pin of what the admin is looking at, its status, the newest version key
//   model:certify      certify on that pin (a moved pin is 409 record_changed, thrown to the route)
//   model:retire       retire, optionally naming a replacement
//   model:clearStatus  remove the status
//
// A StatusError comes back as { ok:false, error, field }; anything else is thrown to the route.

import { ipcMain } from './bus';
import * as versions from '../app/versions';
import { parseStatusRef } from '../app/statusDocs';
import { pinOf } from '../analysis/statusPin';
import { certify, clearStatus, retire, statusFor, StatusError } from '../analysis/statusStore';
import { notFound } from '../analysis/statusMessages';

function refusal(err: unknown): { ok: false; error: string; field: StatusError['field'] } {
  if (err instanceof StatusError) return { ok: false, error: err.message, field: err.field };
  throw err;
}

export function register(): void {
  ipcMain.handle('model:review', async (_e, { projectId, ref }: { projectId: string; ref: string }) => {
    const key = ref.toLowerCase();
    const r = parseStatusRef(key);
    const pin = r && (await pinOf(projectId, key));
    if (!r || !pin) return { ok: false as const, error: notFound() };
    const newestKey = (await versions.list(projectId, r.kind, r.id))[0]?.key;
    return { ok: true as const, pin, status: await statusFor(projectId)(key), ...(newestKey && { newestKey }) };
  });

  ipcMain.handle('model:certify', (_e, { projectId, ref, base, note }: { projectId: string; ref: string; base: string; note?: string }) =>
    certify(projectId, ref, base, note ?? '').then((status) => ({ ok: true as const, status }), refusal));

  ipcMain.handle('model:retire', (_e, { projectId, ref, replacedBy, note }: { projectId: string; ref: string; replacedBy?: string; note?: string }) =>
    retire(projectId, ref, replacedBy, note ?? '').then((status) => ({ ok: true as const, status }), refusal));

  ipcMain.handle('model:clearStatus', (_e, { projectId, ref }: { projectId: string; ref: string }) =>
    clearStatus(projectId, ref).then((status) => ({ ok: true as const, status }), refusal));
}
