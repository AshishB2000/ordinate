// The connector registry — MAIN PROCESS ONLY.
//
// One list of every data source the app can read, assembled from the per-family
// modules in this directory. Adding a source is adding a file and one entry in
// FAMILY_MODULES; nothing else in the app learns a new name.
//
// Loading is DEFENSIVE ON PURPOSE. A family module is a thin wrapper over a
// driver (`pg`, `mysql2`, `tedious`, `oracledb`), and a driver that fails to
// load — a bad optional binary, a pruned dependency — must cost the user that
// ONE family, not the whole Connections feature. So each module is required in
// a try/catch and a failure is recorded in `registryDiagnostics()` rather than
// thrown. The single thing we DO throw on is a duplicate id: two connectors
// sharing an id silently shadow each other and the loser becomes unreachable,
// which is a bug that would surface days later as "why does Redshift open a
// MySQL form".
//
// Harvesting is intentionally shape-driven rather than name-driven: a module may
// export its defs as `connectors`, as a default export, or as individually named
// consts, and all three are picked up, because six of these files are written in
// parallel by different hands.

import type { ConnectorDef, ConnectorField } from './types';

// Load order. Also the fallback ordering inside a category.
const FAMILY_MODULES: readonly string[] = [
  './postgres', // PostgreSQL, Redshift, CockroachDB, AlloyDB, Neon, Supabase, Timescale, …
  './mysql',    // MySQL, MariaDB, Aurora MySQL, SingleStore, TiDB, PlanetScale, StarRocks, Doris
  './mssql',    // SQL Server, Azure SQL, Azure Synapse
  './oracle',   // Oracle Database, Oracle Autonomous
  './http',     // ClickHouse, Databricks SQL, Trino, Presto, Elasticsearch, OpenSearch, Druid
  './url',      // the original URL/API JSON source
  './saas',     // Google Sheets, Airtable, Notion, Stripe, GitHub, HubSpot
];

// Picker grouping order. Anything with an unrecognised category sorts last —
// it is still reachable, just not ahead of the known groups.
const CATEGORY_ORDER: readonly string[] = ['Databases', 'Cloud warehouses', 'Query engines', 'Files & local', 'Apps & SaaS'];
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(CATEGORY_ORDER);
const FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'password', 'select', 'checkbox']);

export interface RegistryDiagnostics {
  /** Modules in FAMILY_MODULES that could not be required at all. */
  missing: string[];
  /** Modules that loaded but exported nothing shaped like a ConnectorDef. */
  empty: string[];
  /** Load failures, module → message. A missing module also appears here. */
  errors: Record<string, string>;
  /** Connector count per module, for a quick sanity read. */
  counts: Record<string, number>;
}

const diagnostics: RegistryDiagnostics = { missing: [], empty: [], errors: {}, counts: {} };

// Shape check. A module can export anything; only objects that satisfy the whole
// ConnectorDef contract — including `readOnly === true` and callable
// listTables/run — are admitted. Half a connector is not a connector.
function isConnectorDef(v: unknown): v is ConnectorDef {
  if (!v || typeof v !== 'object') return false;
  // ponytail: probing an unknown module export — every access is guarded below.
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === 'string' && d.id.length > 0 &&
    typeof d.label === 'string' && d.label.length > 0 &&
    typeof d.family === 'string' && d.family.length > 0 &&
    typeof d.category === 'string' && KNOWN_CATEGORIES.has(d.category) &&
    d.readOnly === true &&
    Array.isArray(d.fields) &&
    typeof d.listTables === 'function' &&
    typeof d.run === 'function'
  );
}

// Pull every ConnectorDef out of a loaded module, whatever it called them.
// Dedupes by object identity so `export const pg` + `export default [pg]` does
// not register the same def twice.
function harvest(mod: unknown): ConnectorDef[] {
  const out: ConnectorDef[] = [];
  const seen = new Set<unknown>();
  const take = (v: unknown): void => {
    if (isConnectorDef(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  if (!mod || typeof mod !== 'object') return out;
  // ponytail: a CommonJS module namespace is an untyped bag by definition.
  for (const value of Object.values(mod as Record<string, unknown>)) {
    if (Array.isArray(value)) value.forEach(take);
    else take(value);
  }
  return out;
}

function loadAll(): ConnectorDef[] {
  const all: ConnectorDef[] = [];
  const byId = new Map<string, string>(); // id → module that registered it

  for (const spec of FAMILY_MODULES) {
    let mod: unknown;
    try {
      // Indirect through a variable so this stays a runtime lookup: a family
      // module that has not been written yet must not be a compile error.
      const req: (id: string) => unknown = require;
      mod = req(spec);
    } catch (err: unknown) {
      diagnostics.missing.push(spec);
      diagnostics.errors[spec] = err instanceof Error ? err.message : String(err);
      diagnostics.counts[spec] = 0;
      continue;
    }

    const defs = harvest(mod);
    diagnostics.counts[spec] = defs.length;
    if (defs.length === 0) diagnostics.empty.push(spec);

    for (const def of defs) {
      const prior = byId.get(def.id);
      if (prior !== undefined) {
        // Loud, at module load, on the machine of whoever added the collision.
        throw new Error(
          `[connectors] Duplicate connector id "${def.id}": registered by ${prior} and ${spec}. ` +
          'Ids are persisted on connection records — pick a different one.',
        );
      }
      byId.set(def.id, spec);
      all.push(def);
    }
  }

  // Stable grouped order: by category (known first, in CATEGORY_ORDER), then by
  // load order within the category. Array.prototype.sort is stable in Node.
  return all.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category);
    const bi = CATEGORY_ORDER.indexOf(b.category);
    return (ai < 0 ? CATEGORY_ORDER.length : ai) - (bi < 0 ? CATEGORY_ORDER.length : bi);
  });
}

const REGISTRY: ConnectorDef[] = loadAll();
const BY_ID: ReadonlyMap<string, ConnectorDef> = new Map(REGISTRY.map((d) => [d.id, d]));

/** Every connector this process offers, grouped by category in picker order. */
export function listConnectors(): ConnectorDef[] {
  return REGISTRY;
}

/** Resolve one connector. Returns null for an unknown id — NEVER throws, because
 *  the id comes off a stored record and a record can outlive a connector (the
 *  desktop's local-file sources — a DuckDB file, a Parquet or CSV folder — went
 *  with it at T8.1, so a record naming one gets null: "Unknown connection kind"). */
export function getConnector(id: unknown): ConnectorDef | null {
  if (typeof id !== 'string' || !id) return null;
  return BY_ID.get(id) ?? null;
}

/** True when this id is one the registry can actually run. */
export function isKnownConnectorId(id: unknown): boolean {
  return getConnector(id) !== null;
}

/** What went wrong at load, if anything. Used by the self-check and by whoever
 *  is wondering why a family is missing from the picker. */
export function registryDiagnostics(): RegistryDiagnostics {
  return {
    missing: diagnostics.missing.slice(),
    empty: diagnostics.empty.slice(),
    errors: { ...diagnostics.errors },
    counts: { ...diagnostics.counts },
  };
}

// ── The renderer-safe view ───────────────────────────────────────────────────

export interface CatalogField {
  key: string;
  label: string;
  type: ConnectorField['type'];
  required: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  secret: boolean;
  help?: string;
}

export interface CatalogEntry {
  id: string;
  label: string;
  family: string;
  category: string;
  blurb?: string;
  fields: CatalogField[];
  /** True when this connector implements `describeTable`, i.e. when the
   *  workbench's schema browser has a catalog to read. Reported rather than
   *  inferred from `family`: gating the run UI on family is what cost seven
   *  HTTP connectors their table picker once already. */
  browsable: boolean;
  /** The fixed hosts a SaaS source may contact — shown on its form. Absent
   *  when the user supplies the host. */
  hosts?: string[];
}

// Rebuilt field-by-field, never spread. A ConnectorDef holds two live functions
// (which would throw on the structured clone IPC uses) and, in a future
// connector, could pick up any property at all; the renderer gets exactly the
// six keys the picker needs and nothing else. `secret` is REPORTED so the
// renderer can render a password input and route the value into the one-way
// secret payload — the flag travels, never a value.
function catalogField(f: ConnectorField): CatalogField {
  const out: CatalogField = {
    key: String(f.key),
    label: String(f.label),
    type: FIELD_TYPES.has(f.type) ? f.type : 'text',
    required: f.required === true,
    secret: f.secret === true,
  };
  if (typeof f.placeholder === 'string') out.placeholder = f.placeholder;
  if (typeof f.help === 'string') out.help = f.help;
  if (typeof f.default === 'string' || typeof f.default === 'number' || typeof f.default === 'boolean') {
    // A `default` on a secret field would be a shipped credential. Drop it.
    if (f.secret !== true) out.default = f.default;
  }
  if (Array.isArray(f.options)) {
    out.options = f.options
      .filter((o) => o && typeof o.value === 'string' && typeof o.label === 'string')
      .map((o) => ({ value: o.value, label: o.label }));
  }
  return out;
}

/** The ONLY connector data a renderer may see: identity + form shape. No
 *  functions, no values, nothing secret. Safe to send over IPC as-is. */
export function connectorCatalog(): CatalogEntry[] {
  return listConnectors().map((d) => {
    const entry: CatalogEntry = {
      id: d.id,
      label: d.label,
      family: d.family,
      category: d.category,
      fields: (d.fields || []).map(catalogField),
      browsable: typeof d.describeTable === 'function',
    };
    if (typeof d.blurb === 'string') entry.blurb = d.blurb;
    if (Array.isArray(d.hosts)) entry.hosts = d.hosts.filter((h) => typeof h === 'string');
    return entry;
  });
}

/** Field keys this connector routes to the secret store. */
export function secretFieldKeys(def: ConnectorDef): string[] {
  return (def.fields || []).filter((f) => f.secret === true).map((f) => f.key);
}
