import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

/** The record types that keep a history (src/app/versions.ts). */
const VersionType = z.enum(['dataset', 'visual', 'dashboard', 'metric', 'report']);
const Of = { projectId: Uuid, type: VersionType, id: Uuid };
/** A version's key: its save time with ':' and '.' as '-' (versions.ts KEY_RE checks the full shape). */
const Key = z.string().max(40);

// Version history (T2.2, src/ipc/versions.ts). A restore is a SAVE of the old
// content through the record's own store, recorded as a new version — so it
// is an edit (`write`), and history stays append-only.
export const versions = {
  // preload: invoke('versions:list', { projectId, type, id }) — newest first, at most 50.
  'versions:list': rpc({ access: 'read', input: z.strictObject(Of), project: byProjectId }),
  // preload: invoke('versions:get', { projectId, type, id, key }) — one version's content.
  'versions:get': rpc({ access: 'read', input: z.strictObject({ ...Of, key: Key }), project: byProjectId }),
  // preload: invoke('versions:restore', { projectId, type, id, key })
  'versions:restore': rpc({ access: 'write', input: z.strictObject({ ...Of, key: Key }), project: byProjectId }),
} as const;
