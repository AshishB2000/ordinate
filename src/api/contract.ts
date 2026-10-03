// The RPC contract: what makes a handler reachable over HTTP. A channel with no
// contract is a 404 even when a handler is registered (plan §4), so the API
// grows one checked channel at a time.
//
// `input` validates the handler's ONE payload argument — every contracted
// channel takes `(event, payload)`. `access` is the narrowest role that may
// call it, and every contract says WHAT that role is checked against
// (src/server/authz/, before the handler runs):
//
//   project  the project the parsed input names — `(i) => i.projectId`, or an
//            async lookup for a channel that names only a record id. The
//            caller's role on THAT project must reach `access`. Nothing
//            resolved → 403.
//   org      no project: the caller's org role must reach `access`
//            (read → any member). `visible` trims a cross-project list to the
//            projects the caller may read; `creates` names the project a
//            channel just made, so its creator is granted admin on it.
//
// A contract with neither is refused at compile time here and listed by
// scripts/check-contracts.ts (part of `npm test`).

import { z } from 'zod';

export type Access = 'read' | 'write' | 'admin';

interface Base<I extends z.ZodType> {
  readonly access: Access;
  readonly input: I;
  /** Audit a `read` channel too (exports). `write` and `admin` are always audited. */
  readonly audit?: true;
}

export interface ProjectScoped<I extends z.ZodType = z.ZodType> extends Base<I> {
  /** The project id the input names; null/undefined (or a throw) → 403. Method syntax: bivariant in its input. */
  project(input: z.output<I>): string | null | undefined | Promise<string | null | undefined>;
}

export interface OrgScoped<I extends z.ZodType = z.ZodType> extends Base<I> {
  readonly org: true;
  /** A list spanning projects: keep what `canRead(projectId)` allows. */
  visible?(output: unknown, canRead: (projectId: string) => boolean): unknown;
  /** The id of the project this call created (from its output), or undefined. */
  creates?(output: unknown): string | undefined;
}

export type Contract<I extends z.ZodType = z.ZodType> = ProjectScoped<I> | OrgScoped<I>;

export function rpc<I extends z.ZodType>(c: ProjectScoped<I>): ProjectScoped<I>;
export function rpc<I extends z.ZodType>(c: OrgScoped<I>): OrgScoped<I>;
export function rpc<I extends z.ZodType>(c: Contract<I>): Contract<I> {
  return Object.freeze({ ...c });
}

/** The projectId field of an input — the resolver almost every project channel uses. */
export const byProjectId = (input: { projectId: string }): string => input.projectId;

/** Keeps the items of a list whose `key` field names a project the caller may read. */
export const onlyReadable =
  (key: string) =>
  (output: unknown, canRead: (projectId: string) => boolean): unknown =>
    // Fail closed: a reply that is not a list shows nothing.
    Array.isArray(output) ? output.filter((x: unknown) => !!x && typeof x === 'object' && canRead(String((x as Record<string, unknown>)[key]))) : [];

/** A record id, as UUID_RE spells it everywhere a record id reaches a path. */
export const Uuid = z.guid();

/** A token from `POST /api/files` (src/server/files.ts): 32 random bytes, base64url. */
export const FileToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * Pipeline / filter steps from a client. Bounded in shape and count only: every
 * handler that takes them runs its own whitelist (`transforms.sanitizeSteps`,
 * `visuals.sanitizeFilters`) before anything reads a step.
 */
export const Steps = z.array(z.looseObject({ type: z.string().max(64) })).max(200);
