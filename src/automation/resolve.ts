// Name → record resolution for automation, and the job wrapper — MAIN PROCESS.
//
// A caller names a project, dataset, dashboard, report or metric by id OR by
// exact name, because a script written by a person uses names and a script
// written by a tool round-trips ids. One rule for all five (`pick`), so
// "Sales" means the same thing to `datasets describe` as to `insights`.

import * as projects from '../app/projects';
import * as jobs from '../app/jobs';
import type { JobKind } from '../app/jobs';
import { AutomationError } from './errors';

/**
 * The project a command runs in when none is named: the one the user was last
 * IN, never an archived one — the renderer's own rule (projects.ts
 * resolveProjectId), so the CLI's default is the project the app would open.
 */
export function defaultProject(list: projects.Project[]): projects.Project | null {
  const key = (p: projects.Project): string => p.lastOpenedAt || p.updatedAt || '';
  const live = list.filter((p) => !p.archivedAt).sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  return live[0] || null;
}

/**
 * By id first, then exact name, then a case-insensitive name — each only when
 * it is unambiguous. Two records sharing a name is an error that names the
 * way out (use the id), never a silent pick of one of them.
 */
export function pick<T extends { id: string; name: string }>(list: readonly T[], ref: string, what: string): T {
  const r = ref.trim();
  const byId = list.find((x) => x.id === r);
  if (byId) return byId;
  for (const same of [(x: T) => x.name === r, (x: T) => x.name.toLowerCase() === r.toLowerCase()]) {
    const hits = list.filter(same);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new AutomationError('usage', `${hits.length} ${what}s are called "${r}" — use the id instead (${hits.map((x) => x.id).join(', ')}).`);
    }
  }
  throw new AutomationError('not_found', `No ${what} called "${r}".`);
}

export async function resolveProject(ref?: string): Promise<projects.Project> {
  const list = await projects.listProjects();
  if (ref && ref.trim()) return pick(list, ref, 'project');
  const p = defaultProject(list);
  if (!p) throw new AutomationError('not_found', 'There are no projects yet. Open Ordinate once, or name one with --project.');
  return p;
}

/**
 * Run `fn` as a background job, so it shows in the Jobs popover — directly in
 * the GUI process, and through userData/automation-log.jsonl from a headless
 * one (headless.ts appends every finished job there; src/ipc/automation.ts
 * tails it). Awaited: the caller answers with the job's own outcome.
 */
export async function runJob<T>(
  spec: { kind: JobKind; label: string; projectId?: string; datasetId?: string },
  fn: (progress: (fraction: number, note?: string) => void) => Promise<T>,
  message: (value: T) => string,
): Promise<T> {
  const job = jobs.submit<T>({
    ...spec,
    cancellable: false,
    run: (jc) => fn((p, note) => jc.progress(p, note)),
    resultOf: (v) => ({ message: message(v) }),
  });
  return job.done;
}
