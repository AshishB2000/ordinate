// Live on a PostgreSQL read replica (docs/live-data/00-plan.md L3.2, D8) — MAIN ONLY.
//
// An OLTP database stays a copy by default. Its connector CAN be Live (it
// declares the Redshift dialect, whose spellings are all plain Postgres), but a
// connection is offered Live only once it is ticked "This is a read replica or
// a warehouse" — `ConnectorLive.optIn` names that checkbox, `isLiveOffered`
// (src/connectors/index.ts) reads it off the connection's stored values.
//
//   liveOfferRefusal(def, values)  why Live is NOT offered for one connection,
//                                  as a catalog sentence — or null. The create
//                                  flow, `dataset:setMode` and the executor
//                                  (src/engine/live/liveTarget.ts) all refuse
//                                  with it, so no path reaches a primary.
//   connection:setLiveOptIn        tick or untick the opt-in on a saved
//                                  connection (the workbench's details rail).
//
// UNTICKING WHILE LIVE DATASETS ASK THE CONNECTION IS REFUSED, naming how many.
// Switching them back to copies instead was considered and rejected: each
// switch is a full import — a large read from the very database just called a
// primary — and it would silently change what every dashboard over them means
// (a cached live figure becomes a dated copy). Refusing keeps both explicit:
// the person switches each dataset ("Copy the data instead"), then unticks.
// The count and the write are not atomic; a Live dataset created in between
// still never reaches the database, because the executor asks the rule again
// on every question and refuses with the same sentence.

import * as connections from '../connectors/connections';
import { getConnector, isLiveCapable, isLiveOffered } from '../connectors';
import type { ConnectorDef } from '../connectors/types';
import * as datasets from '../data/datasets';
import * as msg from '../data/liveMessages';
import { formatNumber } from '../app/format';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The opt-in checkbox's own label, for the sentences that name it. */
function optInLabel(def: ConnectorDef): string {
  const key = def.live?.optIn;
  return (def.fields || []).find((f) => f.key === key)?.label ?? key ?? '';
}

/** Why one connection is not offered Live (a catalog sentence), or null when it is. */
export function liveOfferRefusal(def: ConnectorDef | null | undefined, values: Record<string, unknown> | null | undefined): string | null {
  if (!def || !isLiveCapable(def)) return msg.liveNotOfferedMessage();
  return isLiveOffered(def, values) ? null : msg.liveNeedsOptInMessage(optInLabel(def));
}

/** How many Live datasets of this project ask this connection. */
export async function liveDatasetsOn(projectId: string, connId: string): Promise<number> {
  return (await datasets.listDatasets(projectId)).filter((d) => d.originConnId === connId && d.mode === 'live').length;
}

/** `connection:setLiveOptIn`: `{projectId, connId, on}` → `{ok, on}`, or a refusal (`code: 'live_in_use'` with the count). */
export async function setLiveOptIn(p: Record<string, unknown>) {
  const projectId = str(p.projectId);
  const connId = str(p.connId);
  const conn = await connections.getConnection(projectId, connId);
  if (!conn) return { ok: false, error: 'Connection not found' };
  const def = getConnector(conn.connectorId);
  const key = def?.live?.optIn;
  if (!def || !key || !isLiveCapable(def)) return { ok: false, error: msg.liveNoOptInMessage() };
  const on = p.on === true;
  if (!on) {
    const n = await liveDatasetsOn(projectId, connId);
    if (n > 0) return { ok: false, code: 'live_in_use', liveDatasets: n, error: msg.liveOptInInUseMessage(n, formatNumber(n), optInLabel(def)) };
  }
  const saved = await connections.updateConnection(projectId, connId, { values: { [key]: on } });
  if (!saved) return { ok: false, error: 'Could not change the connection' };
  return { ok: true, on: saved.values[key] === true };
}
