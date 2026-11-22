// Autopilot (docs/autopilot/00-design.md, phases 2 to 4): the org admin's settings per project, the weekly runs and their reports.
// Every channel is an ORG ADMIN's: Autopilot reads whole projects and acts as an org admin, so it is not a project role's to run.
// A reply carries chart names, dataset names and counts, never a figure or a row. Handlers: src/server/autopilot/rpc.ts.

import { z } from 'zod';
import { rpc, Uuid } from './contract';

const Project = z.strictObject({ projectId: Uuid });

export const autopilot = {
  // Every project of the org with its settings, its status ("waiting for data", paused, on) and its latest run.
  'autopilot:overview': rpc({ access: 'admin', org: true, input: z.undefined() }),
  // A partial update. Switching it ON records the caller as the admin it acts as.
  'autopilot:save': rpc({
    access: 'admin',
    org: true,
    input: z.strictObject({
      projectId: Uuid,
      enabled: z.boolean().optional(),
      windowDays: z.number().int().min(30).max(365).optional(),
      slowSeconds: z.number().min(0.5).max(600).optional(),
      trashUnused: z.boolean().optional(),
      repairRenames: z.boolean().optional(),
    }),
  }),
  // The same body as the weekly run, at once, as the caller. Only while Autopilot is on for the project.
  'autopilot:runNow': rpc({ access: 'admin', org: true, input: Project }),
  'autopilot:runs': rpc({ access: 'admin', org: true, input: Project }),
  'autopilot:run': rpc({ access: 'admin', org: true, input: z.strictObject({ projectId: Uuid, runId: Uuid }) }),
  // One row of a report (`seq`), or every applied repair of the run (no `seq`).
  'autopilot:undo': rpc({ access: 'admin', org: true, input: z.strictObject({ projectId: Uuid, runId: Uuid, seq: z.number().int().min(1).max(100_000).optional() }) }),
} as const;
