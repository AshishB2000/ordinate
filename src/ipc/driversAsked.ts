// "Why did this change?" questions the Assistant can be asked about, by token —
// a short-lived RECORD so any pod can recall one (docs/any-pod/00-design.md §3.7).
//
// One record per project, userData/projects/<project>/drivers.json, holding the
// newest ASKED_KEPT questions for ASKED_TTL_MS: bounded by construction, so
// nothing sweeps it. A question is a spec and its parameters — never a figure;
// the Assistant recomputes the answer under the asker's own row rules.
//
// Remembering is BEST-EFFORT: a busy or failed write costs the follow-up its
// context (no token), never the answer it follows.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as recordFs from '../app/recordFs';
import { projectDir } from '../app/recordKinds';
import type { DriversSpec } from '../analysis/driverScope';

const ASKED_KEPT = 20;
const ASKED_TTL_MS = 24 * 3_600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A parameter Map (a tile's resolved values) is stored as its entries; a renderer payload as it came. */
interface Asked { spec: DriversSpec; params?: unknown; paramEntries?: Array<[string, unknown]>; at: number }

const fileOf = (projectId: string): string => {
  const dir = projectDir(projectId);
  return dir ? path.join(dir, 'drivers.json') : '';
};

async function load(file: string): Promise<Record<string, Asked>> {
  try {
    const o = JSON.parse(await recordFs.readFile(file, 'utf8')) as { v?: unknown; asked?: unknown };
    return o && o.v === 1 && o.asked && typeof o.asked === 'object' ? (o.asked as Record<string, Asked>) : {};
  } catch {
    return {};
  }
}

/** Remembers a question for the Assistant; its token, or undefined when it could not be written. */
export async function remember(projectId: string, spec: DriversSpec, params: unknown): Promise<string | undefined> {
  const file = fileOf(projectId);
  if (!file) return undefined;
  const token = randomUUID();
  const entry: Asked = params instanceof Map ? { spec, paramEntries: [...params], at: Date.now() } : { spec, params, at: Date.now() };
  try {
    await recordFs.locked(file, async () => {
      const now = Date.now();
      const kept = Object.entries({ ...(await load(file)), [token]: entry })
        .filter(([, a]) => a && typeof a.at === 'number' && now - a.at <= ASKED_TTL_MS)
        .sort((x, y) => y[1].at - x[1].at)
        .slice(0, ASKED_KEPT);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await recordFs.writeFile(tmp, JSON.stringify({ v: 1, asked: Object.fromEntries(kept) }));
      await recordFs.rename(tmp, file);
    });
    return token;
  } catch {
    return undefined;
  }
}

/** A remembered question of this project, for the Assistant's facts — or null (unknown, expired, another project's). */
export async function recall(projectId: string, token: unknown): Promise<{ spec: DriversSpec; params: unknown } | null> {
  const file = typeof token === 'string' && UUID_RE.test(token) ? fileOf(projectId) : '';
  if (!file) return null;
  const a = (await load(file))[token as string];
  if (!a || typeof a.at !== 'number' || Date.now() - a.at > ASKED_TTL_MS) return null;
  return { spec: a.spec, params: a.paramEntries ? new Map(a.paramEntries) : a.params };
}
