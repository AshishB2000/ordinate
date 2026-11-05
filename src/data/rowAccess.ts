// Row access rules, enforced — MAIN PROCESS. docs/row-policy/00-design.md.
//
// A restricted caller (a project viewer, ../server/authz/caller.ts) reads a
// dataset with rules only through a door that appended their lock
// (`rowLockFor`, then `withRowLock`). Everything else refuses, typed:
//
//   - the STORAGE NET (D8): `gateRows` is the first line of `datasets.getDataset`
//     and `datasets.residentSource`. Outside the lock scope of THAT dataset, a
//     restricted caller is refused — so a reader nobody listed refuses instead
//     of leaking;
//   - readers that never touch storage (stored artifacts, caches, the value
//     index) call `gateRows` themselves, or `closedToCaller` to skip;
//   - FAN-OUT (D10): inside `fanOutScope` every door and the net refuse ANY
//     dataset with rules, or built from one, for every caller — and the scope
//     remembers it, so a tile-level catch cannot turn the refusal into a page
//     that publishes; `assertFanOutAllowed` checks a send's dataset ids;
//   - EXPORTS (D11): inside `exportScope` a restricted caller is refused;
//   - COLUMN RULES (semantic layer part 4): a dataset that hides a column from the
//     caller (./columnGate) is closed to every reader outside a door that gated the
//     question (ipc/columnDoors.gateColumns, the `checked` scope).
//
// The rules are read RAW from the current record (never through the as-of hooks,
// which swap in a snapshot's metadata), once per request per dataset.

import { AsyncLocalStorage } from 'node:async_hooks';
import { ctx } from '../server/context';
import { callerOn } from '../server/authz/caller';
import { isValidId } from '../app/ids';
import { stableStringify } from '../engine/queryCache';
import { storedRules, withFirstWritePolicy, type KeptRules } from './datasetRecord';
import { memoOf, readRawRecord as readRaw, type Raw } from './rawRecord';
import { columnReason, columnView, columnsRuled, upstreamHides } from './columnGate';
import { asOfIso } from './asOf';
import { isTermStep } from './termStep';
import type { FilterStep } from './transforms';
import { makeLock, type Lock } from './rowLock';
import { entitlement, policyFromRecord, ruleState, type RowPolicy } from './rowPolicy';
import { parentsOfRecord, upstreamIds } from './upstream';

export { ROW_POLICY_CODE, RowPolicyError, isRowPolicyError, rowPolicyRaised, rowPolicyRefusal, tagRowPolicyRefusals } from './rowPolicyError';
export type { RowPolicyReason } from './rowPolicyError';
import { RowPolicyError, isRowPolicyError, type RowPolicyReason } from './rowPolicyError';

// ── Scopes ──────────────────────────────────────────────────────────────────

interface Outgoing {
  readonly kind: 'fanout' | 'export';
  readonly datasets: Set<string>;
  refused: RowPolicyReason | null;
}

interface Scope {
  /** The one dataset the innermost door locked. */
  readonly locked?: string;
  readonly out?: Outgoing;
  /** The datasets the innermost door's column gate checked the question against (ipc/columnDoors). */
  readonly checked?: ReadonlySet<string>;
}

const scopes = new AsyncLocalStorage<Scope>();

/** Refuses, typed — and a fan-out or export build remembers it, so a tile-level catch cannot publish around it. */
export function refuseInScope(reason: RowPolicyReason): never {
  const out = scopes.getStore()?.out;
  if (out && !out.refused) out.refused = reason;
  throw new RowPolicyError(reason);
}
const refuse: (reason: RowPolicyReason) => never = refuseInScope;

/** Runs `fn` as the door that locked `datasetId`: the storage net lets that one dataset through. */
export function withRowLock<T>(datasetId: string, fn: () => Promise<T>): Promise<T> {
  const parent = scopes.getStore();
  return scopes.run({ locked: datasetId, ...(parent?.out ? { out: parent.out } : {}), ...(parent?.checked ? { checked: parent.checked } : {}) }, fn);
}

/** Runs `fn` as a door whose column gate checked the question against `ids`: the net lets their whole-table reads through. */
export function withColumnsChecked<T>(ids: ReadonlySet<string>, fn: () => Promise<T>): Promise<T> {
  return scopes.run({ ...scopes.getStore(), checked: ids }, fn);
}

async function outgoing<T>(kind: Outgoing['kind'], fn: () => Promise<T>): Promise<{ value: T; datasets: string[] }> {
  const out: Outgoing = { kind, datasets: new Set(), refused: null };
  const value = await scopes.run({ out }, fn);
  if (out.refused) throw new RowPolicyError(out.refused); // even when a tile's catch swallowed the throw
  return { value, datasets: [...out.datasets] };
}

/** A publish, embed, subscription or alert build: any dataset with rules (or built from one) refuses for every caller. */
export function fanOutScope<T>(fn: () => Promise<T>): Promise<{ value: T; datasets: string[] }> {
  return outgoing('fanout', fn);
}

/** An export: a restricted caller is refused a dataset with rules; editors export as before. */
export function exportScope<T>(fn: () => Promise<T>): Promise<{ value: T; datasets: string[] }> {
  return outgoing('export', fn);
}

/** Inside a fan-out build? Its doors gate (and record) every dataset a question reads, for every caller. */
export function inFanOut(): boolean {
  return scopes.getStore()?.out?.kind === 'fanout';
}

/** Inside an export? */
export function inExport(): boolean {
  return scopes.getStore()?.out?.kind === 'export';
}

/**
 * The columns of `id` whose values are hidden from the caller here (inside a fan-out: from its least-entitled
 * audience) — EVERY column when the rules do not hold or a dataset upstream hides one, since which columns carry
 * those values is then unknown. Empty for an unrestricted caller. What a reply leaves out or marks.
 */
export async function hiddenColumnsFor(projectId: string, id: string): Promise<ReadonlySet<string>> {
  const audience = inFanOut() ? 'fanout' : 'caller';
  const view = await columnView(projectId, id, audience);
  if (view.state === 'ok' && !(await upstreamHides(projectId, id, audience))) return view.hidden;
  const cols = (await readRaw(projectId, id))?.columns;
  return new Set((Array.isArray(cols) ? cols : []).flatMap((c: { name?: unknown } | null) => (typeof c?.name === 'string' ? [c.name] : [])));
}

const anywhere = new WeakMap<object, Map<string, Promise<ReadonlySet<string>>>>();

/** Every column name hidden from the caller on any dataset of the project (`hiddenColumnsFor`'s union), once per request: conservative on purpose, a false hide never a leak. */
export function hiddenAnywhere(projectId: string): Promise<ReadonlySet<string>> {
  const memo = memoOf(anywhere);
  const key = `${inFanOut() ? 'fanout' : 'caller'}\0${projectId}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = (async () => {
      const out = new Set<string>();
      if (!isValidId(projectId) || (!inFanOut() && !(await restrictedOn(projectId)))) return out;
      const datasets = require('./datasets') as typeof import('./datasets'); // lazy: the dataset store calls into this module
      for (const d of await datasets.listDatasets(projectId)) for (const c of await hiddenColumnsFor(projectId, d.id)) out.add(c);
      return out;
    })();
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
  return hit;
}

// ── The record, raw ─────────────────────────────────────────────────────────

/** none: no row rules here or upstream; own: this dataset's row rules; derived: built from a dataset that has row rules. */
type Effective = { kind: 'none' } | { kind: 'own'; policy: RowPolicy; raw: Raw } | { kind: 'derived' };

const effects = new WeakMap<object, Map<string, Promise<Effective>>>();

async function effectiveUncached(projectId: string, id: string): Promise<Effective> {
  const raw = await readRaw(projectId, id);
  const own = raw ? policyFromRecord(raw) : null;
  // Upstream FIRST, even for a dataset with rules of its own (refutation round 2, #4): rows another
  // dataset's rules govern are not this dataset's rules' to hand out — closed, in phase 1.
  const up = await upstreamIds(id, async (p) => (isValidId(p) ? parentsOfRecord(await readRaw(projectId, p)) : []));
  for (const p of up.ids) {
    const r = isValidId(p) ? await readRaw(projectId, p) : null;
    if (r && policyFromRecord(r)) return { kind: 'derived' };
  }
  // A chain longer than the walk is unknown, never clean (fail closed).
  if (!up.complete) return { kind: 'derived' };
  return raw && own ? { kind: 'own', policy: own, raw } : { kind: 'none' };
}

/**
 * The rules that govern `id`: its own, closed because of an upstream dataset's, or none. Once per request.
 * A record that cannot be read is refused (`unreadable`), never "no rules"; a failure is not remembered.
 */
function effective(projectId: string, id: string): Promise<Effective> {
  const memo = memoOf(effects);
  const key = `${projectId}\0${id}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = effectiveUncached(projectId, id).catch((err: unknown) => {
      throw isRowPolicyError(err) ? err : new RowPolicyError('unreadable');
    });
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
  return hit;
}

/** `effective`, with a failure refused through the scope (so a fan-out build remembers it). */
async function effectiveOrRefuse(projectId: string, id: string): Promise<Effective> {
  try {
    return await effective(projectId, id);
  } catch (err) {
    if (isRowPolicyError(err)) refuse(err.reason);
    throw err;
  }
}

/** Is `id` governed by ROW rules — its own, or an upstream dataset's? For the admin screens and the fan-out checks. */
export async function policyClosed(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  return (await effective(projectId, id)).kind !== 'none';
}

/**
 * Row rules (`policyClosed`) or column rules, here or upstream, for anyone: what a reply sent alike to every
 * reader (a push, a legacy published site, the project's colours) treats as closed.
 */
export async function governed(projectId: string, id: string): Promise<boolean> {
  return (await policyClosed(projectId, id)) || (isValidId(projectId) && isValidId(id) && (await columnsRuled(projectId, id)));
}

// ── The doors ───────────────────────────────────────────────────────────────

function lockValuesOf(raw: Raw, policy: RowPolicy, userId: string | null, teamIds: readonly string[]): Lock {
  const state = ruleState(raw, policy);
  if (state === 'column') refuse('column');
  if (state !== 'ok') refuse('pipeline');
  const values = entitlement(policy, userId, teamIds);
  if (values === 'none' || values === 'all' || values.length === 0) refuse('none');
  const lock = makeLock({ [policy.column]: values });
  if (!lock) refuse('none');
  return lock;
}

/**
 * The caller's lock on `datasetId` (D6, D7): null when nothing restricts them
 * there; a Lock to prepend; or a THROWN RowPolicyError — fan-out, export,
 * as-of, derived, a missing or non-text column, a cross-row / parameterised /
 * changed pipeline, no entitlement. Row rules only: every door asks the column
 * gate (ipc/columnDoors) first.
 */
export async function rowLockFor(projectId: string, datasetId: string): Promise<Lock | null> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return null;
  const out = scopes.getStore()?.out;
  const caller = await callerOn(projectId);
  if (!caller.restricted && out?.kind !== 'fanout') return null;
  const eff = await effectiveOrRefuse(projectId, datasetId);
  if (out) out.datasets.add(datasetId);
  if (eff.kind === 'none') return null;
  if (out?.kind === 'fanout') refuse('fanout');
  if (!caller.restricted) return null;
  if (out?.kind === 'export') refuse('export');
  if (asOfIso()) refuse('asOf');
  if (eff.kind === 'derived') refuse('derived');
  return lockValuesOf(eff.raw, eff.policy, caller.userId, caller.teamIds);
}

/** Why the caller may not read `id`'s rows here, or null — the check only: nothing recorded, nothing thrown. `rowsOnly`: the row rules alone. */
async function closedReason(projectId: string, id: string, rowsOnly = false): Promise<RowPolicyReason | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const scope = scopes.getStore();
  const out = scope?.out;
  const columns = (): Promise<RowPolicyReason | null> => (rowsOnly ? Promise.resolve(null) : columnReason(projectId, id, scope?.checked, out?.kind));
  if (scope?.locked === id && out?.kind !== 'fanout') return columns(); // its door gated the question
  const caller = await callerOn(projectId);
  if (!caller.restricted && out?.kind !== 'fanout') return null;
  let eff: Effective;
  try {
    eff = await effective(projectId, id);
  } catch (err) {
    if (isRowPolicyError(err)) return err.reason; // unreadable: closed
    throw err;
  }
  if (eff.kind === 'none') return columns();
  if (out?.kind === 'fanout') return 'fanout';
  if (!caller.restricted) return null;
  if (out?.kind === 'export') return 'export';
  return eff.kind === 'derived' ? 'derived' : 'reader';
}

/**
 * The storage net (D8), and the check every reader that bypasses storage makes:
 * refuses a restricted caller on a dataset with rules (or built from one) unless
 * this is the lock scope of exactly that dataset; inside a fan-out scope,
 * refuses any such dataset for every caller — and records the read.
 */
export async function gateRows(projectId: string, id: string): Promise<void> {
  const reason = await closedReason(projectId, id);
  const out = scopes.getStore()?.out;
  if (out && isValidId(id)) out.datasets.add(id);
  if (reason) refuse(reason);
}

/**
 * For a walk over datasets that SKIPS what the caller may not read (value search, Home's insights): never throws,
 * never fails a build. `rowsOnly`: closed by row rules alone, for a reply that leaves out the hidden columns itself.
 */
export async function closedToCaller(projectId: string, id: string, opts: { rowsOnly?: boolean } = {}): Promise<boolean> {
  return (await closedReason(projectId, id, opts.rowsOnly)) !== null;
}

/** Is the caller restricted on this project at all? (The `scoped` flag; nothing about the rules leaves.) */
export async function restrictedOn(projectId: string): Promise<boolean> {
  return isValidId(projectId) && (await callerOn(projectId)).restricted;
}

/**
 * THE fan-out check (D10): a send, a published page or an embed that reads any
 * of `datasetIds` refuses when one has rules or is built from one. Item 4's
 * shared `deliver()` calls this with its model's dataset ids.
 */
export async function assertFanOutAllowed(projectId: string, datasetIds: Iterable<string>): Promise<void> {
  for (const id of new Set(datasetIds)) {
    if (await policyClosed(projectId, id)) throw new RowPolicyError('fanout');
  }
}

/** `[...lock, ...filters]`, filter and term steps only (a term is expanded later, never dropped here) — unless `filters` already STARTS WITH exactly the lock (S4). */
export function withLockSteps(lock: Lock, filters: readonly FilterStep[] | undefined): FilterStep[] {
  const only = (Array.isArray(filters) ? filters : []).filter((f): f is FilterStep => !!f && (f.type === 'filter' || isTermStep(f)));
  const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
  const starts = lock.steps.length <= only.length && lock.steps.every((s, i) => same(s, only[i]));
  return starts ? only : [...lock.steps, ...only];
}

/** Does any dataset of the project have row rules — or, unless `rowsOnly`, column rules — (or is built from one)? The legacy `/p/` check and project-wide values (the colour map). */
export async function anyPolicyClosed(projectId: string, rowsOnly = false): Promise<boolean> {
  if (!isValidId(projectId)) return false;
  // Lazy: the dataset store calls into this module, so it is not imported at load time.
  const datasets = require('./datasets') as typeof import('./datasets');
  for (const d of await datasets.listDatasets(projectId)) if (await (rowsOnly ? policyClosed : governed)(projectId, d.id)) return true;
  return false;
}

/** `anyPolicyClosed`, remembered per org and project on this pod for a few seconds — the legacy `/p/` check runs per fetch. */
const ANY_CLOSED_TTL_MS = 15_000;
const anyClosed = new Map<string, { at: number; value: Promise<boolean> }>();

/**
 * `anyPolicyClosed` for a page served per fetch (an older published site, src/publish/hosted.ts). Forgotten at
 * once when this pod saves rules (`rulesChanged`); CEILING: another pod may serve such a page for up to 15 s
 * after rules are first set in its project.
 */
export function anyPolicyClosedRecently(projectId: string): Promise<boolean> {
  const key = ctx().org.id + '\u0000' + projectId;
  const hit = anyClosed.get(key);
  if (hit && Date.now() - hit.at < ANY_CLOSED_TTL_MS) return hit.value;
  const value = anyPolicyClosed(projectId);
  anyClosed.set(key, { at: Date.now(), value });
  value.catch(() => anyClosed.delete(key));
  if (anyClosed.size > 1000) anyClosed.delete(anyClosed.keys().next().value as string);
  return value;
}

/** Rules were saved or removed in `projectId` (dataset:setRowPolicy): what this pod remembers of it goes. */
export function rulesChanged(projectId: string): void {
  anyClosed.delete(ctx().org.id + '\u0000' + projectId);
}

/**
 * The rules a NEW dataset made from `sourceId`'s rows is born with (round 2, #3): none when the source has
 * none; the source's own stored rules (row and column); and, for a closed source with no row rules on its
 * record (closed by an upstream dataset's row or column rules, or its record gone since the check read it),
 * row rules that open nothing (a closed policy). Pass the result to `datasetRecord.withFirstWritePolicy` around the save.
 * A source whose rules cannot be read THROWS — no copy is made without them.
 */
export async function rulesForCopyOf(projectId: string, sourceId: string): Promise<KeptRules | undefined> {
  if (!isValidId(projectId) || !isValidId(sourceId)) return undefined;
  const { kind } = await effective(projectId, sourceId);
  // Its rows carry the values a dataset upstream hides: the copy, with no origin to walk, is born closed.
  const closed = kind !== 'none' || (await upstreamHides(projectId, sourceId, 'fanout'));
  const own = await storedRules(projectId, sourceId);
  // Rules the stored read finds count even when the check found none (saved meanwhile, or a restore mid-read).
  if (!closed && own.rowPolicy == null && !('columnAccess' in own)) return undefined;
  // Its own column rules the copy keeps verbatim. A record gone since gives {}: closed.
  return closed && own.rowPolicy == null ? { ...own, rowPolicy: { column: '', rules: [], stepsHash: '' } } : own;
}

/** Saves a new dataset made from `sourceId`'s rows so that its first record write carries `rulesForCopyOf`. */
export async function savedFrom<T>(projectId: string, sourceId: string, save: () => Promise<T>): Promise<T> {
  const rules = await rulesForCopyOf(projectId, sourceId);
  return rules === undefined ? save() : withFirstWritePolicy(rules, save);
}
