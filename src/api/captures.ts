import { z } from 'zod';
import { byProjectId, FileToken, rpc, Uuid } from './contract';

/** A capture's id: history.ts's own pattern (the desktop's are Date.now()-ish, the server's UUIDs). */
const CaptureId = z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/);

// Captures on the server (T2.4): a screenshot is UPLOADED (POST /api/files),
// read by the org's model on the server, stored as a capture of the project
// and drafted for the composer. src/ipc/captureDataset.ts.
export const captures = {
  // Whether a model can read a screenshot for the caller's org right now — a
  // connected API-key provider the org allows. Drives the not-ready state.
  'captureDataset:status': rpc({ access: 'read', org: true, input: z.undefined() }),
  // An uploaded PNG → a new capture + its table's draft; or a stored capture's
  // draft again. Creates a capture record, hence write. `thumb` is the
  // browser's small preview for the Captures list (a raster data URL, re-checked).
  'captureDataset:draft': rpc({
    access: 'write',
    input: z.union([
      z.strictObject({ projectId: Uuid, fileToken: FileToken, thumb: z.string().max(150_000).optional() }),
      z.strictObject({ projectId: Uuid, captureId: CaptureId }),
    ]),
    project: byProjectId,
  }),
  // One project's captures, newest first — never the crop's server path.
  'captureDataset:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // One stored capture for its own page: the narration, the app's headline,
  // metrics and chart data, and its table as the composer would open it.
  'captureDataset:get': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, captureId: CaptureId }),
    project: byProjectId,
  }),
  // The screenshot itself as a PNG data URL — the page's <img>; the crop's
  // server path never leaves the server.
  'captureDataset:image': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, captureId: CaptureId }),
    project: byProjectId,
  }),
  // Deletes a capture of THIS project (another project's id is not found).
  'captureDataset:delete': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, captureId: CaptureId }),
    project: byProjectId,
  }),
} as const;
