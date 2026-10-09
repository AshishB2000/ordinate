// The connector contract. ONE definition per data source, all conforming to
// this shape, so adding a source is adding a file — never editing a union type
// in four places, which is what `ConnectionKind = 'postgres' | 'url'` forced.
//
// MAIN PROCESS ONLY. A ConnectorContext carries resolved secrets; nothing in
// this file may be imported by a renderer.
//
// Three rules that are not negotiable, because they are promises the product
// already makes elsewhere:
//
//   1. READ-ONLY. Every connector issues SELECT-shaped work and nothing else.
//      `readOnly` is not a capability flag to be toggled — it documents that
//      this app has no write path, and a connector that needs one does not
//      belong here.
//   2. SECRETS NEVER LEAVE MAIN. A field marked `secret` is stored in
//      config.connectionSecrets, never in the project folder (which is
//      shareable), never returned to a renderer, and stripped from error
//      strings. See src/connections.ts publicConnection().
//   3. EVERY QUERY IS BOUNDED. `rowLimit` and `timeoutMs` are supplied by the
//      caller and a connector MUST apply both. An unbounded query against a
//      warehouse is how a local-first app becomes someone's surprise bill.

import type { ColumnType } from '../data/parse';
import type { PinnedHost } from './ssrf';

/** One input on the connection form. Rendered generically by the renderer. */
export interface ConnectorField {
  /** Stored on the connection record (or in secrets when `secret` is true). */
  key: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'select' | 'checkbox' | 'textarea';
  required?: boolean;
  placeholder?: string;
  /** Prefilled when the form opens. Ports belong here, not in prose. */
  default?: string | number | boolean;
  /** For `type: 'select'` only. */
  options?: { value: string; label: string }[];
  /** Route to config.connectionSecrets instead of the project record. */
  secret?: boolean;
  /** One line under the input. Keep it factual — no marketing. */
  help?: string;
}

export interface ConnectorTable {
  /** Schema/database/dataset, when the source has one. */
  schema?: string;
  name: string;
}

export interface ConnectorColumn {
  name: string;
  /** The SOURCE's type name, verbatim. Mapping to Ordinate's ColumnType is the
   *  caller's job — a connector must not guess, because `007` stays text. */
  type: string;
  /**
   * Set ONLY when the source's own schema says what the column is (an API that
   * documents a field as a number, a date, or text) — never guessed from values.
   * The dispatch keeps it instead of re-detecting, so a text field holding
   * "12345" stays text and an integer amount stays a number. SQL drivers leave
   * it unset and keep the CSV-identical detection.
   */
  columnType?: ColumnType;
}

export interface ConnectorRows {
  ok: true;
  columns: ConnectorColumn[];
  /** Positional, matching `columns`. Values are string | number | boolean | null. */
  rows: (string | number | boolean | null)[][];
  /** True when `rowLimit` clipped the result. Report it; never trim silently. */
  truncated: boolean;
}

export interface ConnectorTables {
  ok: true;
  tables: ConnectorTable[];
}

/** One column as the SOURCE's own catalog describes it. Richer than
 *  ConnectorColumn because a catalog knows things a result-set header does not:
 *  whether the column accepts NULL, and (per table) roughly how many rows there
 *  are. `type` is still the source's verbatim type name — mapping it to
 *  Ordinate's ColumnType stays the caller's job, so `007` stays text. */
export interface ConnectorColumnDetail {
  name: string;
  type: string;
  /** Omitted when the catalog does not say. `false` means NOT NULL. */
  nullable?: boolean;
}

export interface ConnectorSchema {
  ok: true;
  columns: ConnectorColumnDetail[];
  /** The optimiser's row ESTIMATE, not a count. Never shown as a fact — the
   *  schema tree renders it as "~12k". Omitted when the catalog has none. */
  rowEstimate?: number;
}

export interface ConnectorError {
  ok: false;
  /** User-facing. MUST NOT contain a password, token, or connection string. */
  error: string;
}

/** Everything a connector needs for one operation. Built in main, per call. */
export interface ConnectorContext {
  /** Non-secret field values, keyed by ConnectorField.key. */
  values: Record<string, unknown>;
  /** Resolved secrets, keyed by ConnectorField.key. Main-process only. */
  secrets: Record<string, string>;
  /** Hard cap on returned rows. The connector applies it. */
  rowLimit: number;
  /** Hard cap on wall-clock for one operation. The connector applies it. */
  timeoutMs: number;
  /**
   * Server only (T6.1): the `host` field resolved, checked and pinned by
   * connectionRun. A DB driver connects to `pinned.address` (TLS still names
   * `pinned.host`), so DNS answering differently at connect time changes nothing.
   */
  pinned?: PinnedHost;
  /**
   * Live data (docs/live-data/00-plan.md): what this query is for — 'live' or
   * 'extract'. Tagged on the warehouse's own query log (Snowflake QUERY_TAG,
   * BigQuery job labels) so the bill can be read back per purpose.
   */
  costTag?: 'live' | 'extract';
  /** BigQuery `maximumBytesBilled` ceiling for this query; ignored elsewhere. */
  maxBytes?: number;
  /** Fired when the caller gives up (the client hung up, a timeout). A connector
   *  that can cancel server-side (Snowflake, BigQuery) does so on it. */
  signal?: AbortSignal;
}

/** A warehouse SQL dialect the live compiler targets (plan D2). */
export type LiveDialectId = 'snowflake' | 'bigquery' | 'redshift' | 'databricks' | 'clickhouse';

/**
 * One bind parameter of a compiled live query (plan D4: values are NEVER
 * inlined into SQL text). The compiler never reuses a parameter: `params[i]`
 * is the (i+1)-th placeholder in the statement's text order, named `p<i>`.
 * Placeholder spelling is the dialect's own:
 *   snowflake `?` · bigquery `@p0` · databricks `:p0` · clickhouse `{p0:Type}`
 *   · redshift `$1`.
 * `date` and `timestamp` values are ISO-8601 strings (UTC for timestamps).
 */
export interface LiveParam {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'timestamp';
  value: string | number | boolean | null;
}

/** A connector's live capability: run one compiled, parameterised statement. */
export interface ConnectorLive {
  dialect: LiveDialectId;
  /** Run `sql` with `params` bound, under ctx's row cap, timeout and signal. */
  runBound(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<ConnectorRows | ConnectorError>;
  /** A free dry run's byte estimate, where the warehouse offers one (BigQuery). */
  estimate?(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<{ ok: true; bytes: number } | ConnectorError>;
}

export interface ConnectorDef {
  /** Stable id, kebab-case. Persisted on connection records — NEVER rename one
   *  without a migration; an existing project stores this string. */
  id: string;
  /** Shown in the picker, e.g. "Amazon Redshift". */
  label: string;
  /** Which driver implements it: 'postgres' | 'mysql' | 'mssql' | 'http' |
   *  'duckdb'. Sources sharing a wire protocol share an implementation. */
  family: string;
  /** Grouping in the picker UI. */
  category: 'Databases' | 'Cloud warehouses' | 'Query engines' | 'Files & local' | 'Apps & SaaS';
  /** Always true. See rule 1 above. */
  readOnly: true;
  /** One factual line for the picker tile. */
  blurb?: string;
  /**
   * The ONLY hosts this connector may contact, for a source whose host is fixed
   * (a SaaS API). `*.example.com` matches any subdomain. Declared so the network
   * allowlist is explicit and shown on the form; the request code refuses any
   * URL — including a redirect — whose host is not on it. Absent for a source
   * whose host the user types (a database, a query engine).
   */
  hosts?: readonly string[];
  fields: ConnectorField[];
  listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError>;
  run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError>;
  /**
   * One table's columns out of the SOURCE'S OWN CATALOG, plus a row estimate.
   *
   * OPTIONAL, and its absence is the signal the workbench reads: a connector
   * that cannot describe a table is not browsable, so the schema tree and the
   * sample grid are hidden for it rather than shown empty. That is why HTTP
   * engines and the URL source deliberately do not implement it — a Trino or
   * Elasticsearch endpoint answers `listTables` but has no uniform catalog to
   * ask, and a tree that lists tables you cannot open is worse than no tree.
   *
   * The table name is the SAME string `listTables` returned (schema-qualified
   * where that source qualifies), and every implementation must BIND it as a
   * value or whitelist it — it arrives from a renderer.
   */
  describeTable?(ctx: ConnectorContext, table: string): Promise<ConnectorSchema | ConnectorError>;
  /**
   * OPTIONAL. Present only on a connector that can answer a Live dataset's
   * questions itself (plan D2). Still one registry entry per connector — this
   * is a property, never a second kind of connector.
   */
  live?: ConnectorLive;
}

/** Redact anything that looks like a credential before it reaches a renderer.
 *  Connector errors are driver strings and drivers DO put DSNs in them. */
export function safeError(e: unknown, secrets?: Record<string, string>): string {
  let msg = e instanceof Error ? e.message : String(e ?? 'Unknown error');
  // Strip any literal secret value first — the cheapest and most reliable pass.
  for (const v of Object.values(secrets || {})) {
    if (v && v.length >= 3) msg = msg.split(v).join('***');
  }
  // Then credentials embedded in a URL, e.g. postgres://user:pw@host.
  msg = msg.replace(/\/\/[^/@\s]*:[^/@\s]*@/g, '//***:***@');
  return msg.slice(0, 500);
}
