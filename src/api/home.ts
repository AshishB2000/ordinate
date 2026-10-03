import { z } from 'zod';
import { byProjectId, onlyReadable, rpc, Uuid } from './contract';

export const home = {
  // preload: invoke('recent:list', { limit }) — limit is optional (default 50
  // in the handler); Home asks for the default, the palette for 6. Spans the
  // org's projects, so it is trimmed to the ones the caller may read.
  'recent:list': rpc({
    access: 'read',
    org: true,
    input: z.strictObject({ limit: z.number().int().min(1).max(500).optional() }).optional(),
    visible: onlyReadable('projectId'),
  }),
  // T2.1 — Home and the app chrome.
  //
  // Server only: one project at a glance — record counts, its datasets, its
  // first saved visuals (src/ipc/recent.ts). Replaces the four list reads the
  // desktop Home makes, and the browser never counts.
  'home:overview': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // preload: invoke('starred:get') / invoke('starred:set', { ids }) — the
  // caller's OWN pins ("type:id" keys), so any member may read and set them.
  'starred:get': rpc({ access: 'read', org: true, input: z.undefined() }),
  'starred:set': rpc({
    access: 'read',
    org: true,
    input: z.strictObject({ ids: z.array(z.string().min(1).max(100)).max(1000) }),
  }),
  // preload: invoke('onboarding:status') — the Get-started card: which steps
  // are done (booleans, latched from the org's records) and the sample's ids.
  'onboarding:status': rpc({ access: 'read', org: true, input: z.undefined() }),
  // preload: invoke('onboarding:set', { collapsed?, dismissed?, coachSeen? }) —
  // the card is the org's, so folding or hiding it is an editor's call.
  'onboarding:set': rpc({
    access: 'write',
    org: true,
    input: z.strictObject({
      collapsed: z.boolean().optional(),
      dismissed: z.literal(true).optional(),
      coachSeen: z.literal(true).optional(),
    }),
  }),
  // hubPlatform: listJobs / cancelJob / clearJobs. The handlers act on the
  // caller's own jobs only (src/ipc/jobs.ts registerServer), so a member needs
  // nothing more than membership. No `jobs:reveal`: a server has no file manager.
  'jobs:list': rpc({ access: 'read', org: true, input: z.undefined() }),
  'jobs:cancel': rpc({ access: 'read', org: true, input: z.strictObject({ id: Uuid }) }),
  'jobs:clear': rpc({ access: 'read', org: true, input: z.undefined() }),
  // preload: invoke('prefs:get') — the workspace's formats and branding (accent,
  // dashboard style; never the logo file). Secret-free by construction.
  'prefs:get': rpc({ access: 'read', org: true, input: z.undefined() }),
} as const;
