// Home's "Your numbers": the metrics and scorecards each person follows in a
// project, as tiles. A metric's tile is its latest CLOSED period, the change on
// the period before it (good or bad by the metric's own direction), and the
// periods behind it; a metric with no date column shows its total. A
// scorecard's tile is how many of its goals are off track.
//
// THE APP DOES THE MATH, and it does it ONCE: every figure here is another
// channel's reply (`metric:series`, `metric:value`, `scorecard:compute`), asked
// through the registered handlers as `metric:table` asks them. So a tile cannot
// disagree with the Metrics tab or the scorecard, and every access rule those
// channels hold (row locks, Live, the as-of scope) holds here unchanged.
//
// Following is the caller's own, like a star (config.followingBy, per member).
// Nothing followed yet: the project's first metrics come back as suggestions.

import { ipcMain } from './bus';
import { handlers } from '../server/rpc';
import * as config from '../app/config';
import { ctx, serverDataDir } from '../server/context';
import { periodChange } from '../analysis/scorecardModel';
import { pctText } from './scorecards';

type Kind = 'metric' | 'scorecard';
/** How many of the project's metrics are offered while nothing is followed. */
const SUGGEST = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface MetricTile {
  kind: 'metric';
  id: string;
  name: string;
  dataset: string | null;
  /** The figure as the metric formats it; '' when there is none. */
  display: string;
  /** The period the figure is for ("Dec 2024"); null for a total. */
  period: string | null;
  change: { text: string; up: boolean; tone: 'good' | 'bad' | 'flat' | 'neutral'; vs: string } | null;
  /** The periods up to and including `period`, for the sparkline. */
  spark: Array<number | null> | null;
  /** When the figure is from (metric:value's, e.g. a Live dataset's warehouse time). */
  asOf?: unknown;
  error?: string;
}
export interface GoalsTile { kind: 'scorecard'; id: string; name: string; period: string; off: number; warn: number; good: number; scored: number; error?: string }

/** A registered handler, called as the RPC layer calls it (analysesServer.ts `call`). */
async function call(event: unknown, channel: string, payload: unknown): Promise<any> { // any: each handler's own reply
  const h = handlers.get(channel);
  if (!h) return { ok: false, error: `${channel} is not available` };
  try {
    return await h(event, payload);
  } catch (err: any) { // any: a handler's throw
    return { ok: false, error: err?.message || `${channel} failed` };
  }
}

/** The caller's key in `followingBy`: their email on a server. */
const me = (): string => (serverDataDir() === null ? '' : ctx().user.email);

export function followed(projectId: string): string[] {
  return config.get().followingBy[me()]?.[projectId] ?? [];
}

/** "2024-12" → "Dec 2024"; any other period key is already words. */
export function periodName(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${MONTHS[+m[2] - 1]} ${m[1]}` : key;
}

interface MetricRow { id: string; name: string; datasetName: string | null; direction?: 'up_good' | 'down_good' }

async function metricTile(e: unknown, projectId: string, m: MetricRow): Promise<MetricTile> {
  const base = { kind: 'metric' as const, id: m.id, name: m.name, dataset: m.datasetName };
  const s = await call(e, 'metric:series', { projectId, id: m.id });
  const series = s && s.ok !== false ? s.series : null;
  const n = series ? series.values.length : 0;
  if (n) {
    const value = series.values[n - 1];
    const prev = n > 1 ? series.values[n - 2] : null;
    const ch = periodChange(value, prev, m.direction);
    return {
      ...base,
      display: series.display[n - 1] ?? '',
      period: periodName(String(series.labels[n - 1])),
      change: ch.pct === null || ch.delta === null ? null : { text: pctText(ch.pct), up: ch.delta > 0, tone: ch.tone, vs: periodName(String(series.labels[n - 2])) },
      spark: n > 1 ? series.values : null,
    };
  }
  // No date to run along (or the series failed): the metric's whole figure.
  const v = await call(e, 'metric:value', { projectId, id: m.id });
  if (!v || v.ok === false) return { ...base, display: '', period: null, change: null, spark: null, error: v?.error || 'Could not compute this metric.' };
  return { ...base, display: v.display ?? '', period: null, change: null, spark: null, ...(v.asOf ? { asOf: v.asOf } : {}) };
}

async function goalsTile(e: unknown, projectId: string, id: string, name: string): Promise<GoalsTile> {
  const r = await call(e, 'scorecard:compute', { projectId, id });
  if (!r || r.ok === false) return { kind: 'scorecard', id, name, period: '', off: 0, warn: 0, good: 0, scored: 0, error: r?.error || 'Could not compute the scorecard.' };
  const c = r.counts as Record<'good' | 'warn' | 'off' | 'none', number>;
  return { kind: 'scorecard', id, name: r.name, period: r.window?.label ?? '', off: c.off, warn: c.warn, good: c.good, scored: c.good + c.warn + c.off };
}

export function register(): void {
  ipcMain.handle('numbers:get', async (e, { projectId }: any = {}) => {
    const listed = await call(e, 'metric:list', { projectId });
    if (!listed || listed.ok === false) return { ok: false, error: listed?.error || 'Failed to list metrics' };
    const metrics = listed.metrics as MetricRow[];
    const cards = await call(e, 'scorecard:list', { projectId });
    const scorecards = (Array.isArray(cards) ? cards : []) as Array<{ id: string; name: string }>;
    const byId = new Map<string, MetricRow>(metrics.map((m) => [m.id, m]));
    const cardById = new Map(scorecards.map((c) => [c.id, c]));
    // A followed metric or scorecard deleted since is simply not shown.
    const keys = followed(String(projectId)).filter((k) => {
      const [kind, id] = k.split(':') as [Kind, string];
      return kind === 'metric' ? byId.has(id) : cardById.has(id);
    });
    const tiles = await Promise.all(keys.map((k) => {
      const [kind, id] = k.split(':') as [Kind, string];
      return kind === 'metric' ? metricTile(e, projectId, byId.get(id)!) : goalsTile(e, projectId, id, cardById.get(id)!.name);
    }));
    const suggestions = keys.length ? [] : await Promise.all(metrics.slice(0, SUGGEST).map((m) => metricTile(e, projectId, m)));
    return {
      ok: true,
      tiles,
      suggestions,
      // The "Follow a metric" menu: names only, and which are followed.
      choices: [
        ...metrics.map((m) => ({ kind: 'metric' as const, id: m.id, name: m.name, followed: keys.includes(`metric:${m.id}`) })),
        ...scorecards.map((c) => ({ kind: 'scorecard' as const, id: c.id, name: c.name, followed: keys.includes(`scorecard:${c.id}`) })),
      ],
    };
  });

  // Follow or unfollow one metric or scorecard, for the caller only. A followed one goes last.
  ipcMain.handle('numbers:follow', async (e, { projectId, kind, id, on }: any = {}) => {
    const pid = String(projectId);
    const key = `${kind}:${id}`;
    const now = followed(pid).filter((k) => k !== key);
    if (on) {
      if (now.length >= config.FOLLOW_MAX) return { ok: false, error: `You follow ${config.FOLLOW_MAX} numbers here already. Unfollow one first.` };
      const cards = kind === 'scorecard' ? await call(e, 'scorecard:list', { projectId }) : null;
      const exists = kind === 'metric'
        ? (await call(e, 'metric:get', { projectId, id }))?.ok === true
        : Array.isArray(cards) && cards.some((c: { id: string }) => c.id === id);
      if (!exists) return { ok: false, error: kind === 'metric' ? 'Metric not found' : 'Scorecard not found.' };
      now.push(key);
    }
    const cfg = config.get();
    const mine = { ...(cfg.followingBy[me()] ?? {}), [pid]: now };
    config.save({ followingBy: { ...cfg.followingBy, [me()]: mine } });
    return { ok: true, followed: now };
  });
}
