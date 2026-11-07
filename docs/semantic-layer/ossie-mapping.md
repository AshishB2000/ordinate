# How Ordinate's model maps onto Ossie

Read on 2026-11-05 from the Apache Ossie repository (`apache/ossie`, `core-spec/spec.md`; the project was Open Semantic
Interchange until it entered the Apache Incubator). Licence: Apache 2.0.

- **Version pinned: `0.2.0.dev0`.** It is the draft on the default branch ("do not depend on it in production"); the only
  released version is 0.1.1 (2025-12-11), which wraps a model in a `semantic_model` array and is not what is built here.
  A released 0.2.0, or a decision to target 0.1.1, is a new PR.
- **Format:** one JSON or YAML document per model. Ordinate writes JSON (sorted keys, as the model files). Required at the
  root: `version`, `name`, a non-empty `datasets`. Optional: `description`, `ai_context`, `relationships`, `metrics`,
  `custom_extensions`.
- **Schema:** the spec ships a machine-readable schema, but it was not reachable on the day (a 404 at `core-spec/osi-schema.json`),
  and a JSON Schema validator would be a dependency (an owner decision). The test-only check (`scripts/ossieShape.ts`) is
  written from the required keys, types and enums in `spec.md`.
- **Extensions:** `custom_extensions: [{ vendor_name, data }]`, `data` a string holding JSON. Ordinate writes one entry,
  `vendor_name: "ordinate"`.

| Ordinate (D9) | Ossie 0.2.0.dev0 | Result |
|---|---|---|
| Dataset name, description, grain | `datasets[].name`, `description` (grain appended) | mapped |
| Dataset source table | `datasets[].source` (**required**) | the warehouse table for a Live dataset over a table when the caller may open the connection; any other dataset has none, so `source` holds the dataset's own name and the report says so |
| Key | `primary_key` | mapped |
| Role | none | reported |
| Guide | `ai_context.instructions` | mapped |
| Field | `fields[]` with `expression.sql` (the column), `description`, `datatype`, `ai_context` (display name and aliases as `synonyms`, example as `examples`) | mapped; `number` has no `datatype` (Ossie splits Integer/Decimal/Float, Ordinate does not) |
| Value labels, sensitivity | none | reported, labels kept in the extension |
| Simple metric: sum, avg, count, min, max, distinct count | dataset-scoped `metrics[]`, `expression.sql` (`SUM(x)`, `COUNT(DISTINCT x)`) | mapped |
| Count or distinct count of a text field | none exact: `COUNT(x)` counts `''` and whitespace, Ordinate counts only non-blank text, and a `NULLIF(TRIM(x), '')` rewrite is not exact (TRIM's whitespace set varies by dialect) | not mapped, reported; a count of a number or date field maps |
| Metric filters | none | metric not mapped, reported (a metric without its filter would be another number) |
| A metric on a Live dataset with base filters | none: `source` is the whole table | not mapped, reported (the same reason) |
| Formula, period, funnel metric | none: "metrics cannot reference other metrics" | not mapped, reported |
| Snapshot metric | none (no semi-additive measure) | not mapped, reported |
| `timeColumn` | `dimension.is_time` on that field | the field only; which metric counts by it is reported |
| Relationship | `relationships[]` (`from` many side, `to` one side, `from_columns`, `to_columns`) | mapped; one-to-one has no marker, reported |
| Term, base filters, formats, direction, target, calendar | none (no named filters) | reported, kept in the extension |
| Row access rules, secrets, source SQL | never read | |
