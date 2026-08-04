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
  category: 'Databases' | 'Cloud warehouses' | 'Query engines' | 'Files & local';
  /** Always true. See rule 1 above. */
  readOnly: true;
  /** One factual line for the picker tile. */
  blurb?: string;
  fields: ConnectorField[];
  listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError>;
  run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError>;
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
