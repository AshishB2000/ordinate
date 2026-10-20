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
import { datasetFilePath } from './datasetRecord';
import { asOfIso } from './asOf';
import type { FilterStep } from './transforms';
import { makeLock, type Lock } from './rowLock';
import { entitlement, policyFromRecord, ruleState, type RowPolicy } from './rowPolicy';
import { parentsOfRecord, upstreamIds } from './upstream';
import * as msg from './rowAccessMessages';

export const ROW_POLICY_CODE = 'row_policy';
export type RowPolicyReason = 'none' | 'column' | 'pipeline' | 'reader' | 'related' | 'asOf' | 'fanout' | 'export' | 'derived';

const SENTENCES: Record<RowPolicyReason, () => string> = {
  none: msg.rowNoneMessage,
  column: msg.rowColumnMessage,
  pipeline: msg.rowPipelineMessage,
  reader: msg.rowReaderMessage,
  related: msg.rowRelatedMessage,
  asOf: msg.rowAsOfMessage,
  fanout: msg.rowFanOutMessage,
  export: msg.rowExportMessage,
  derived: msg.rowDerivedMessage,
};

let raised = 0;

/** A refusal: the route answers it 409 `row_policy` with its sentence. Never caught to become an empty answer. */
export class RowPolicyError extends Error {
  readonly code = ROW_POLICY_CODE;
  readonly reason: RowPolicyReason;
  constructor(reason: RowPolicyReason) {
    super(SENTENCES[reason]());
    this.name = 'RowPolicyError';
    this.reason = reason;
    raised++;
  }
}

/** True for a RowPolicyError — by class, or by name and code when it crossed a module copy. */
export function isRowPolicyError(err: unknown): err is RowPolicyError {
  if (err instanceof RowPolicyError) return true;
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && typeof e === 'object' && e.name === 'RowPolicyError' && e.code === ROW_POLICY_CODE;
}

/** How many refusals this process has raised — the route walks a reply for them only when this moved. */
export function rowPolicyRaised(): number {
  return raised;
}

/** The refusal as a reply, for a handler or a door whose contract answers `{ok:false, error}`. */
export function rowPolicyRefusal(reason: RowPolicyReason): { ok: false; code: typeof ROW_POLICY_CODE; reason: RowPolicyReason; error: string } {
  return { ok: false, code: ROW_POLICY_CODE, reason, error: SENTENCES[reason]() };
}

/**
 * Type the refusals a handler caught: every `{ok:false}` whose `error` (or
 * `reason`) IS one of the sentences gets the code and the reason — per item in
 * a batch, a few levels deep, as `tagLiveRefusals` does. Mutates and returns.
 */
export function tagRowPolicyRefusals<T>(reply: T, depth = 3): T {
  const bySentence = new Map((Object.keys(SENTENCES) as RowPolicyReason[]).map((r) => [SENTENCES[r](), r]));
  const walk = (v: unknown, d: number): void => {
    if (d < 0 || !v || typeof v !== 'object' || ArrayBuffer.isView(v)) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, d - 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const said = typeof o.error === 'string' ? o.error : typeof o.reason === 'string' ? o.reason : '';
    const reason = o.ok === false && o.code === undefined ? bySentence.get(said) : undefined;
    if (reason) {
      o.code = ROW_POLICY_CODE;
      if (typeof o.reason !== 'string') o.reason = reason; // an answer card's `reason` is its sentence: kept
      if (typeof o.error !== 'string') o.error = said;
    }
    for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x, d - 1);
  };
  walk(reply, depth);
  return reply;
}

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

function readRaw(projectId: string, id: string): Promise<Raw | null> {
  const memo = memoOf(reads);
  const key = `${projectId}\0${id}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = recordFs.readFile(datasetFilePath(projectId, id), 'utf8').then(
      (text) => {
        const raw: unknown = JSON.parse(text);
        return raw && typeof raw === 'object' ? (raw as Raw) : null;
      },
      () => null,
    );
    memo.set(key, hit);
  }
  return hit;
}

async function effectiveUncached(projectId: string, id: string): Promise<Effective> {
  const raw = await readRaw(projectId, id);
  const own = raw ? policyFromRecord(raw) : null;
  if (raw && own) return { kind: 'own', policy: own, raw };
  const up = await upstreamIds(id, async (p) => (isValidId(p) ? parentsOfRecord(await readRaw(projectId, p)) : []));
  for (const p of up.ids) {
    const r = isValidId(p) ? await readRaw(projectId, p) : null;
    if (r && policyFromRecord(r)) return { kind: 'derived' };
  }
  // A chain longer than the walk is unknown, never clean (fail closed).
  return up.complete ? { kind: 'none' } : { kind: 'derived' };
}

/** The rules that govern `id`: its own, closed because of an upstream dataset's, or none. Once per request. */
function effective(projectId: string, id: string): Promise<Effective> {
  const memo = memoOf(effects);
  const key = `${projectId}\0${id}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = effectiveUncached(projectId, id);
    memo.set(key, hit);
  }
  return hit;
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
  const eff = await effective(projectId, datasetId);
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
  const eff = await effective(projectId, id);
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
