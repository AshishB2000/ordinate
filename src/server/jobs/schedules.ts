// The server's schedules: the desktop's one-minute tick, run through the jobs
// table (./runner.ts) once per org instead of on a per-process timer.
//
// The desktop wires src/app/refreshScheduler.ts in src/app/refreshWiring.ts
// (unchanged; it still runs there). This is the server's copy of that wiring,
// and it runs the SAME tickNow, so everything that rides the tick keeps its
// order — due dataset refreshes, then alert rules (the anomaly watch is an
// `anomaly` rule) and quality checks on the fresh data, then the after-tick
// work: pipeline crons (src/app/pipelineRunner.tick → pipelineCron) and the
// Trash purge.
//
// What changes on the server is delivery — no OS notification, no hub window:
//   hub:dataset-refreshed  → every tab of a member who may READ the project
//   alerts:fired           → the same, one per project per tick; and to the Slack /
//                            Teams channels a rule names (../subscriptions/alertPosts.ts)
// both through sse.publish, so a tab on any pod gets them. Not the whole org
// (T6.3): an alert carries the project's figures and a refresh its dataset's
// name, and an org member with no grant on the project must see neither. A
// failed refresh's push says which dataset, never why: its error can quote a value or a warehouse table.
// Not every reader either (shared folders D17): each goes to those who open what
// it is about — an event's rule's dashboard or dataset, the refreshed dataset (and its reachers, D9) —
// one push per reader with only theirs, so without folders it is today's push.
//
// A SUCCESSFUL refresh is announced by refreshAsJob itself (data/refreshEvents,
// L0.1) — for every door, the tick's included — so the tick's reporter pushes
// only a FAILED one here; announcing both would send a scheduled success twice.
//
// Every scheduled refresh that RAN leaves an audit row (`scheduled_refresh`,
// live data L0.5): the actor is the jobs identity it ran as, the outcome the
// refresh's own. One that coalesced with a refresh already running started
// nothing and leaves none (refreshScheduler reports only what ran).
//
// Not carried over: `reports:run-due` (the desktop renderer generates reports;
// the server has no generator until the reports port), the alert "explain"
// model call (T2.12 routes AI keys first).

import * as scheduler from '../../app/refreshScheduler';
import type { AutoRefreshOutcome, TickAlerts } from '../../app/refreshScheduler';
import type { AlertEvent } from '../../analysis/alerts';
import * as config from '../../app/config';
import * as pipelineRunner from '../../app/pipelineRunner';
import * as alertStore from '../../analysis/alertStore';
import type { Pool } from 'pg';
import { readerEmails, writerEmails } from '../authz/index';
import { openers } from '../authz/folderGate';
import type { PlacedKind } from '../authz/folders';
import { audit } from '../authz/audit';
import { ctx } from '../context';
import { publish } from '../sse';
import { defineJob } from './runner';
import { scheduleRepublish } from '../../publish/hosted';

/** The desktop tick's interval (refreshScheduler TICK_MS). */
export const TICK_EVERY_MS = 60_000;

let wired = false;
let readersVia: { pool: Pool; devAuth: boolean } | null = null;

/**
 * Pushes `channel` to the tabs of every member who may read `projectId`. Under
 * dev sign-in (`everyone`) there is one identity and it is an org admin, so the
 * org is the same set of tabs.
 */
export async function toReaders(pool: Pool, everyone: boolean, projectId: string, channel: string, payload: unknown, writersOnly = false): Promise<void> {
  const org = ctx().org.id;
  if (everyone) return publish({ org }, channel, payload);
  for (const user of await (writersOnly ? writerEmails : readerEmails)(pool, org, projectId)) publish({ org, user }, channel, payload);
}

/** What a push is about; `reach`: a refreshed dataset, whose reachers (D9) get it too. */
export type Anchor = { kind: PlacedKind; id: string; reach?: true };

/**
 * `items` to each member who opens their anchor at `min` (shared folders D17), ONE push per member carrying only
 * theirs, in order (`wrap` builds it): with no folder besides Everyone, every reader gets every item, as `toReaders`.
 */
export async function toOpeners<T>(pool: Pool, everyone: boolean, projectId: string, channel: string, items: readonly T[], anchorOf: (x: T) => Anchor, wrap: (mine: T[]) => unknown, min: 'view' | 'edit' = 'view'): Promise<void> {
  const org = ctx().org.id;
  if (everyone) return publish({ org }, channel, wrap([...items]));
  const groups = new Map<string, { anchor: Anchor; items: Set<T> }>();
  for (const x of items) {
    const a = anchorOf(x);
    const key = `${a.kind}:${a.id.toLowerCase()}:${a.reach === true}`;
    (groups.get(key) ?? groups.set(key, { anchor: a, items: new Set() }).get(key)!).items.add(x);
  }
  const mine = new Map<string, Set<T>>();
  for (const g of groups.values()) {
    for (const user of await openers(pool, org, projectId, g.anchor, min)) {
      const set = mine.get(user) ?? mine.set(user, new Set()).get(user)!;
      for (const x of g.items) set.add(x);
    }
  }
  for (const [user, set] of mine) publish({ org, user }, channel, wrap(items.filter((x) => set.has(x))));
}

/**
 * `toReaders` for a handler outside the tick (an "evaluate now", a comment
 * written — T2.9). Without Postgres there are no grants and the one identity is
 * the dev admin, so the org's tabs are the readers. `anchor`: only those who open it (D17).
 */
export function pushToReaders(projectId: string, channel: string, payload: unknown, anchor?: Anchor): void {
  if (!readersVia) return publish({ org: ctx().org.id }, channel, payload);
  const done = anchor ? toOpeners(readersVia.pool, readersVia.devAuth, projectId, channel, [payload], () => anchor, ([p]) => p) : toReaders(readersVia.pool, readersVia.devAuth, projectId, channel, payload);
  void done.catch(() => undefined);
}

/** `pushToReaders` for the members who may WRITE the project — "someone else saved this" (src/app/editConflict.ts); `anchor`: who may edit it (D17). */
export function pushToWriters(projectId: string, channel: string, payload: unknown, anchor?: Anchor): void {
  if (!readersVia) return publish({ org: ctx().org.id }, channel, payload);
  const done = anchor ? toOpeners(readersVia.pool, readersVia.devAuth, projectId, channel, [payload], () => anchor, ([p]) => p, 'edit') : toReaders(readersVia.pool, readersVia.devAuth, projectId, channel, payload, true);
  void done.catch(() => undefined);
}

/** What a failed scheduled refresh tells every reader's tabs: which dataset, never why (the web reads `ok`, `projectId`, `datasetId`). A driver's error quotes the relation it could not find. */
export function failedRefreshPayload(o: AutoRefreshOutcome): Omit<AutoRefreshOutcome, 'error'> {
  const { error: _error, ...rest } = o;
  return rest;
}

type Push = (projectId: string, channel: string, payload: unknown) => void;

/** What a fired event is about (D17): its rule's dashboard when it was made from one, else its dataset — alertStore.load's rule. */
export const eventAnchor = (e: AlertEvent): Anchor => (e.analysisId ? { kind: 'dashboard', id: e.analysisId } : { kind: 'dataset', id: e.datasetId });

/** Each reader's tabs, with the events whose rule they open (D17). */
async function firedToOpeners(projectId: string, events: AlertEvent[]): Promise<void> {
  if (!readersVia) return publish({ org: ctx().org.id }, 'alerts:fired', { projectId, events });
  await toOpeners(readersVia.pool, readersVia.devAuth, projectId, 'alerts:fired', events, eventAnchor, (mine) => ({ projectId, events: mine }));
}

/**
 * The bell's push for fired events: each reader's tabs with the events they open, and no figure from a dataset with
 * row access rules (docs/row-policy, "Pushes"). `push`: a test's own, sent the whole list. Never rejects.
 */
export function pushFired(projectId: string, events: AlertEvent[], push?: Push): Promise<void> {
  return alertStore.pushableEvents(projectId, events).then((ev) => (push ? push(projectId, 'alerts:fired', { projectId, events: ev }) : firedToOpeners(projectId, ev))).catch(() => undefined);
}

/**
 * What a rule's fired events become on EVERY path — the tick, a ↻, an input-table save, a snapshot restore,
 * fresh on ask, a refresh URL, MCP, a pipeline's alert step (docs/notifications §5.3-5.4): the push each
 * reader's bell repaints from, and — for a rule that names Slack / Teams / email channels — a post there with
 * the same sentence and figure (../subscriptions/alertPosts.ts), at most once per event id across paths and pods.
 * `pushed` may be awaited (a request path does, so the bell is right when it answers); `posted` never is.
 */
export function deliverFired(projectId: string, events: AlertEvent[], push?: Push): { pushed: Promise<void>; posted: Promise<number> } {
  // Lazy: that module reaches back here (through ./run) for `toReaders`.
  const { postFiredAlerts } = require('../subscriptions/alertPosts') as typeof import('../subscriptions/alertPosts');
  return { pushed: pushFired(projectId, events, push), posted: postFiredAlerts(projectId, events) };
}

/** A tick's fired alerts, per project, through `deliverFired`. Returns the posts in flight, for a test to wait on. */
export function deliverTickAlerts(batches: TickAlerts[], push?: Push): Promise<number>[] {
  return batches.map((b) => deliverFired(b.projectId, b.events, push).posted);
}

/**
 * Hooks the tick's callbacks to server delivery and declares the `tick` job.
 * Once per process. `devAuth`: AUTH_MODE=dev (see `toReaders`).
 */
export function wireSchedules(pool: Pool, devAuth: boolean): void {
  if (wired) return;
  wired = true;
  readersVia = { pool, devAuth };

  scheduler.setEnabledCheck(() => config.get().autoRefresh !== false);
  scheduler.onRefreshed((o) => {
    // A failure's text can quote a value (row-policy N2) or a warehouse relation (D13): no reader's tab gets it.
    if (!o.ok) void toOpeners(pool, devAuth, o.projectId, 'hub:dataset-refreshed', [failedRefreshPayload(o)], () => ({ kind: 'dataset', id: o.datasetId, reach: true }), ([p]) => p).catch(() => undefined);
    // A published site that reads it, opted in, is rebuilt at its link (T2.9; the desktop's job hook).
    if (o.ok) scheduleRepublish(o.projectId, o.datasetId);
    const { org, user, requestId } = ctx(); // the tick's: the job identity, for this org
    void audit(pool, { org: org.id, actor: user.email, action: 'scheduled_refresh', projectId: o.projectId, targets: [o.datasetId], outcome: o.ok ? 'ok' : 'error', requestId })
      .catch(() => undefined); // the trail must not stop the tick; the refresh itself is recorded on the dataset
  });
  // The store's evaluator directly: ipc/alerts' delivery is the RPC layer's.
  scheduler.onEvaluateAlerts(async (projectId, datasetId) => {
    await alertStore.syncWatchRules(projectId);
    return alertStore.evaluateProject(projectId, datasetId);
  });
  scheduler.onTickAlerts((batches) => deliverTickAlerts(batches)); // each event to those who open it (pushFired)
  // ponytail: ipc/pipelines adds this same hook when registered; it is not
  // registered on the server yet — drop this when it is. (ipc/trash is, since
  // T2.2: its own afterTick hook runs the 30-day Trash purge.)
  scheduler.afterTick(() => { void pipelineRunner.tick().catch(() => undefined); });

  defineJob('tick', {
    everyMs: TICK_EVERY_MS,
    // Out of budget: due full refreshes may be left (never begun, still due); the runner runs the row again soon.
    run: async (_target, stopAt) => {
      await scheduler.tickNow(Date.now(), stopAt);
      return Date.now() >= stopAt;
    },
  });
}
