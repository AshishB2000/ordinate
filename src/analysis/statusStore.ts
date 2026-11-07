// Certified and retired status (semantic layer part 4, D1–D6, D11) — MAIN PROCESS ONLY. The store is the catalog's
// `status` section (../app/statusDocs.ts), written under the catalog's lock (`updateStatus`). Status is never content:
// no record save, restore, duplicate or `setDoc` writes it, and it changes no figure and no cache key.
//
// Stored: certified (with the pin of what was reviewed, ./statusPin) or retired. Read: `certified` while the pin
// still matches, `needs_review` once anything the figure depends on moved, `retired`, or none. Every change is a
// version event of the item (../app/versions.ts), recorded even when the content did not move.

import * as catalog from '../app/catalog';
import * as versions from '../app/versions';
import { clip } from '../app/clip';
import { parseStatusRef, type StatusDoc, type StatusKind } from '../app/statusDocs';
import { ctx, serverDataDir } from '../server/context';
import * as datasets from '../data/datasets';
import { versionRecordOf } from '../data/inputTable/store';
import * as metrics from './metrics';
import { getTerm } from './terms';
import { pinOf } from './statusPin';
import * as msg from './statusMessages';

export type StatusState = 'certified' | 'needs_review' | 'retired';

export interface StatusView {
  state: StatusState;
  by: string;
  at: string;
  note: string;
  /** Certified (or changed since): the version the certify event wrote, for `versions:diff` to now. */
  versionKey?: string;
  /** Retired: what replaces it, by its current name. Absent when none was named or that item is gone. */
  replacedBy?: { ref: string; name: string };
}

/** A refusal with the sentence for the box it belongs beside. */
export class StatusError extends Error {
  readonly field: 'ref' | 'replacedBy';
  constructor(field: 'ref' | 'replacedBy', message: string) {
    super(message);
    this.name = 'StatusError';
    this.field = field;
  }
}

const MAX_NOTE = 500;

/** The record a status event versions (what its own saves version), or null when the item is gone. */
async function recordOf(projectId: string, kind: StatusKind, id: string): Promise<object | null> {
  if (kind === 'metric') return metrics.getMetric(projectId, id);
  if (kind === 'term') return getTerm(projectId, id);
  const meta = await datasets.getDatasetMeta(projectId, id); // metadata: a Live dataset never reaches getDataset
  if (!meta) return null;
  if (meta.sourceKind !== 'input') return { id, steps: meta.steps || [] };
  const ds = await datasets.getDataset(projectId, id); // an input table's version carries its table
  return ds && versionRecordOf(ds);
}

async function nameOf(projectId: string, ref: string): Promise<string | null> {
  const r = parseStatusRef(ref);
  if (!r) return null;
  if (r.kind === 'metric') return (await metrics.getMetric(projectId, r.id))?.name ?? null;
  if (r.kind === 'term') return (await getTerm(projectId, r.id))?.name ?? null;
  return (await datasets.getDatasetMeta(projectId, r.id))?.name ?? null;
}

async function viewOf(projectId: string, ref: string, doc: StatusDoc): Promise<StatusView> {
  const base = { by: doc.by, at: doc.at, note: doc.note };
  if (doc.status === 'certified') {
    const same = !!doc.pin && doc.pin === (await pinOf(projectId, ref)); // a gone item has no pin: needs_review
    return { state: same ? 'certified' : 'needs_review', ...base, ...(doc.versionKey && { versionKey: doc.versionKey }) };
  }
  const name = doc.replacedBy ? await nameOf(projectId, doc.replacedBy) : null;
  return { state: 'retired', ...base, ...(doc.replacedBy && name !== null && { replacedBy: { ref: doc.replacedBy, name } }) };
}

// The section, read once per request and project. Keyed by the request's own context object (per org), so no
// request ever reads another's; the desktop shares one context object for the whole process, so it reads every time.
const sections = new WeakMap<object, Map<string, Promise<Record<string, StatusDoc>>>>();

function sectionOf(projectId: string): Promise<Record<string, StatusDoc>> {
  const read = (): Promise<Record<string, StatusDoc>> => catalog.load(projectId).then((f) => f.status ?? (Object.create(null) as Record<string, StatusDoc>));
  if (!serverDataDir()) return read();
  const req = ctx();
  let byProject = sections.get(req);
  if (!byProject) sections.set(req, (byProject = new Map()));
  let p = byProject.get(projectId);
  if (!p) byProject.set(projectId, (p = read()));
  return p;
}

/** ref -> its status as read now, or null for none. One catalog read per request; each pin is compared when asked. */
export function statusFor(projectId: string): (ref: string) => Promise<StatusView | null> {
  return async (ref) => {
    const section = await sectionOf(projectId);
    const doc = Object.prototype.hasOwnProperty.call(section, ref) ? section[ref] : undefined;
    return doc ? viewOf(projectId, ref, doc) : null;
  };
}

/**
 * Certify what the admin reviewed: `base` is the pin `model:review` handed them. A pin that moved since is refused
 * the way a stale edit is (409 record_changed, the current pin as its tag), so nobody certifies what they did not see.
 */
export async function certify(projectId: string, rawRef: string, base: string, note: string): Promise<StatusView> {
  const ref = rawRef.toLowerCase();
  const r = parseStatusRef(ref);
  const current = r && (await pinOf(projectId, ref));
  if (!r || !current) throw new StatusError('ref', msg.notFound());
  if (current !== base) throw Object.assign(new Error(msg.statusChanged()), { code: 'ERECORDCHANGED', tag: current });
  const rec = await recordOf(projectId, r.kind, r.id);
  if (!rec) throw new StatusError('ref', msg.notFound());
  const version = await versions.record(projectId, r.kind, rec, { event: 'certified' });
  const doc: StatusDoc = {
    status: 'certified', by: catalog.osUser(), at: new Date().toISOString(), note: clip(note, MAX_NOTE), pin: base,
    ...(version && { versionKey: version.key }),
  };
  await catalog.updateStatus(projectId, (s) => { s[ref] = doc; });
  return { state: 'certified', by: doc.by, at: doc.at, note: doc.note, ...(doc.versionKey && { versionKey: doc.versionKey }) };
}

/** Retire an item, optionally naming what replaces it: the same kind, not itself, still there, not retired. */
export async function retire(projectId: string, rawRef: string, rawReplacedBy: string | undefined, note: string): Promise<StatusView> {
  const ref = rawRef.toLowerCase();
  const r = parseStatusRef(ref);
  const rec = r && (await recordOf(projectId, r.kind, r.id));
  if (!r || !rec) throw new StatusError('ref', msg.notFound());
  let to: { ref: string; name: string } | undefined;
  if (rawReplacedBy !== undefined) {
    const toRef = rawReplacedBy.toLowerCase();
    const t = parseStatusRef(toRef);
    if (!t || t.kind !== r.kind) throw new StatusError('replacedBy', msg.replacementKind());
    if (t.id === r.id) throw new StatusError('replacedBy', msg.replacementSelf());
    const name = await nameOf(projectId, toRef);
    if (name === null) throw new StatusError('replacedBy', msg.replacementMissing());
    to = { ref: toRef, name };
  }
  const name = (await nameOf(projectId, ref)) ?? '';
  const doc: StatusDoc = { status: 'retired', by: catalog.osUser(), at: new Date().toISOString(), note: clip(note, MAX_NOTE), ...(to && { replacedBy: to.ref }) };
  // Against the section as it is under the lock: a replacement retired meanwhile, or another item now pointing here.
  await catalog.updateStatus(projectId, (s) => {
    if (to && s[to.ref]?.status === 'retired') throw new StatusError('replacedBy', msg.replacementRetired(to.name));
    if (Object.keys(s).some((k) => k !== ref && s[k].replacedBy === ref)) throw new StatusError('ref', msg.wouldChain(name));
    s[ref] = doc;
  });
  await versions.record(projectId, r.kind, rec, { event: 'retired' });
  return { state: 'retired', by: doc.by, at: doc.at, note: doc.note, ...(to && { replacedBy: to }) };
}

/** Remove an item's status. A version event only when there was one to remove. */
export async function clearStatus(projectId: string, rawRef: string): Promise<null> {
  const ref = rawRef.toLowerCase();
  const r = parseStatusRef(ref);
  if (!r) throw new StatusError('ref', msg.notFound());
  const had = await catalog.updateStatus(projectId, (s) => {
    const was = Object.prototype.hasOwnProperty.call(s, ref);
    delete s[ref];
    return was;
  });
  const rec = had ? await recordOf(projectId, r.kind, r.id) : null;
  if (rec) await versions.record(projectId, r.kind, rec, { event: 'cleared' });
  return null;
}
