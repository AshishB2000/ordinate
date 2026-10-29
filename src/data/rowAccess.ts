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
//   - EXPORTS (D11): inside `exportScope` a restricted caller is refused.
//
// The rules are read RAW from the current record (never through the as-of hooks,
// which swap in a snapshot's metadata), once per request per dataset.

import { AsyncLocalStorage } from 'node:async_hooks';
import { ctx } from '../server/context';
import { callerOn } from '../server/authz/caller';
import * as recordFs from '../app/recordFs';
import { isValidId } from '../app/ids';
import { stableStringify } from '../engine/queryCache';
import { datasetFilePath, storedRowPolicy, withFirstWritePolicy } from './datasetRecord';
import { asOfIso } from './asOf';
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
}

const scopes = new AsyncLocalStorage<Scope>();

function refuse(reason: RowPolicyReason): never {
  const out = scopes.getStore()?.out;
  if (out && !out.refused) out.refused = reason;
  throw new RowPolicyError(reason);
}

/** Runs `fn` as the door that locked `datasetId`: the storage net lets that one dataset through. */
export function withRowLock<T>(datasetId: string, fn: () => Promise<T>): Promise<T> {
  const parent = scopes.getStore();
  return scopes.run({ locked: datasetId, ...(parent?.out ? { out: parent.out } : {}) }, fn);
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

// ── The record, raw ─────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
/** none: no rules here or upstream; own: this dataset's rules; derived: no rules, but built from a dataset that has them. */
type Effective = { kind: 'none' } | { kind: 'own'; policy: RowPolicy; raw: Raw } | { kind: 'derived' };

const reads = new WeakMap<object, Map<string, Promise<Raw | null>>>();
const effects = new WeakMap<object, Map<string, Promise<Effective>>>();

function memoOf<T>(m: WeakMap<object, Map<string, T>>): Map<string, T> {
  const store = ctx() as object;
  let inner = m.get(store);
  if (!inner) {
    inner = new Map();
    m.set(store, inner);
  }
  return inner;
}

/** What a record that does not parse reads as: rules that do not sanitize, so CLOSED (rowPolicy.policyFromRecord). */
const CORRUPT: Raw = Object.freeze({ rowPolicy: '\u0000unparseable' });

/**
 * The record as stored. A record that is not there (ENOENT) has no rules: null. One that does not parse is
 * CLOSED. Any other failure REJECTS — never "no rules" — and is not remembered, so the next ask reads again.
 */
function readRaw(projectId: string, id: string): Promise<Raw | null> {
  const memo = memoOf(reads);
  const key = `${projectId}\0${id}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = recordFs.readFile(datasetFilePath(projectId, id), 'utf8').then(
      (text) => {
        try {
          const raw: unknown = JSON.parse(text);
          return raw && typeof raw === 'object' ? (raw as Raw) : CORRUPT;
        } catch {
          return CORRUPT;
        }
      },
      (err: unknown) => {
        if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
        throw err;
      },
    );
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
  return hit;
}

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

/** Is `id` governed by rules — its own, or an upstream dataset's? For the admin screens and the fan-out checks. */
export async function policyClosed(projectId: string, id: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  return (await effective(projectId, id)).kind !== 'none';
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
 * there; a Lock to prepend; or a THROWN RowPolicyError — fan-out, export, as-of,
 * derived, a missing or non-text column, a cross-row / parameterised / changed
 * pipeline, no entitlement. Called by every door before anything is read.
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

/** Why the caller may not read `id`'s rows here, or null — the check only: nothing recorded, nothing thrown. */
async function closedReason(projectId: string, id: string): Promise<RowPolicyReason | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const scope = scopes.getStore();
  const out = scope?.out;
  if (scope?.locked === id && out?.kind !== 'fanout') return null;
  const caller = await callerOn(projectId);
  if (!caller.restricted && out?.kind !== 'fanout') return null;
  let eff: Effective;
  try {
    eff = await effective(projectId, id);
  } catch (err) {
    if (isRowPolicyError(err)) return err.reason; // unreadable: closed
    throw err;
  }
  if (eff.kind === 'none') return null;
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

/** For a walk over datasets that SKIPS what the caller may not read (value search, Home's insights): never throws, never fails a build. */
export async function closedToCaller(projectId: string, id: string): Promise<boolean> {
  return (await closedReason(projectId, id)) !== null;
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

/** `[...lock, ...filters]`, filter steps only — unless `filters` already STARTS WITH exactly the lock (S4). */
export function withLockSteps(lock: Lock, filters: readonly FilterStep[] | undefined): FilterStep[] {
  const only = (Array.isArray(filters) ? filters : []).filter((f): f is FilterStep => !!f && f.type === 'filter');
  const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
  const starts = lock.steps.length <= only.length && lock.steps.every((s, i) => same(s, only[i]));
  return starts ? only : [...lock.steps, ...only];
}

/** Does any dataset of the project have rules (or is built from one)? The legacy `/p/` check and project-wide values (the colour map). */
export async function anyPolicyClosed(projectId: string): Promise<boolean> {
  if (!isValidId(projectId)) return false;
  // Lazy: the dataset store calls into this module, so it is not imported at load time.
  const datasets = require('./datasets') as typeof import('./datasets');
  for (const d of await datasets.listDatasets(projectId)) if (await policyClosed(projectId, d.id)) return true;
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
 * none; the source's own stored rules; or, for a source closed by an upstream dataset's rules, rules that
 * open nothing (a closed policy). Pass the result to `datasetRecord.withFirstWritePolicy` around the save.
 * A source whose rules cannot be read THROWS — no copy is made without them.
 */
export async function rulesForCopyOf(projectId: string, sourceId: string): Promise<unknown> {
  if (!(await policyClosed(projectId, sourceId))) return undefined;
  const own = await storedRowPolicy(projectId, sourceId);
  return own !== undefined ? own : { column: '', rules: [], stepsHash: '' };
}

/** Saves a new dataset made from `sourceId`'s rows so that its first record write carries `rulesForCopyOf`. */
export async function savedFrom<T>(projectId: string, sourceId: string, save: () => Promise<T>): Promise<T> {
  const rules = await rulesForCopyOf(projectId, sourceId);
  return rules === undefined ? save() : withFirstWritePolicy(rules, save);
}
