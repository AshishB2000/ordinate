# Complete data-source logos design

**Date:** 2026-08-06  
**Branch:** `feat/complete-source-logos`

## Goal

Every one of Ordinate's 35 catalog data sources must show a recognizable,
source-specific mark in the data-source picker. The persistent Home → Connect
shortlist must use the same visual language instead of generic blue squares.

Normal application state must contain no initial badges. The existing initials
path remains only as defensive error handling for a corrupt or unreadable asset.

## Constraints

- Keep the app fully offline: no renderer network requests for logos.
- Keep the hub CSP unchanged; marks are bundled paths or `data:` image URIs.
- Add no runtime dependency. Reuse the installed `simple-icons` build pipeline
  and the existing local connector asset discovery.
- Preserve each vendor mark's proportions and colors. Do not redraw or combine
  marks into a new Ordinate-owned logo.
- Record the provenance of manually bundled assets so they can be refreshed.
- Keep all marks decorative (`aria-hidden="true"` and empty image alt text),
  because the adjacent source label is the accessible name.

## Chosen approach

Use a complete local asset manifest.

1. Keep the 22 Simple Icons connector mappings already baked into
   `assets/provider-icons.json`.
2. Keep the supplied Amazon Redshift PNG.
3. Add local first-party SVG or PNG assets for the 12 currently unmapped
   connector IDs.
4. Add a source/provenance note alongside the connector assets.
5. Make the icon self-check compare the live `connectorCatalog()` IDs against
   `connectorLogos`, failing when any ID lacks a real path or image.

Remote logo URLs are rejected because they violate offline-first behavior and
the hub CSP. Third-party icon packs are not the primary source because their
marks may be unofficial or stale.

## Catalog coverage

| Connector ID | Displayed source | Asset treatment |
|---|---|---|
| `postgres` | PostgreSQL | Existing bundled brand glyph |
| `cockroachdb` | CockroachDB | Existing bundled brand glyph |
| `timescaledb` | TimescaleDB | Existing bundled brand glyph |
| `yugabytedb` | YugabyteDB | Add first-party local mark |
| `materialize` | Materialize | Add first-party local mark |
| `questdb` | QuestDB | Add first-party local mark |
| `risingwave` | RisingWave | Add first-party local mark |
| `mysql` | MySQL | Existing bundled brand glyph |
| `mariadb` | MariaDB | Existing bundled brand glyph |
| `aurora-mysql` | Amazon Aurora (MySQL) | Add official AWS Aurora product icon |
| `tidb` | TiDB | Existing bundled brand glyph |
| `planetscale` | PlanetScale | Existing bundled brand glyph |
| `sqlserver` | Microsoft SQL Server | Add first-party local mark |
| `oracle` | Oracle Database | Add first-party local mark |
| `amazon-redshift` | Amazon Redshift | Existing supplied PNG |
| `alloydb` | Google AlloyDB | Existing Google Cloud glyph |
| `neon` | Neon | Existing bundled brand glyph |
| `supabase` | Supabase | Existing bundled brand glyph |
| `azure-sql` | Azure SQL Database | Add official Azure product icon |
| `azure-synapse` | Azure Synapse Analytics | Add official Azure product icon |
| `oracle-autonomous` | Oracle Autonomous Database | Add first-party local mark |
| `singlestore` | SingleStore | Existing bundled brand glyph |
| `starrocks` | StarRocks | Add first-party local mark |
| `doris` | Apache Doris | Existing bundled brand glyph |
| `clickhouse` | ClickHouse | Existing bundled brand glyph |
| `databricks-sql` | Databricks SQL | Existing bundled brand glyph |
| `trino` | Trino | Existing bundled brand glyph |
| `presto` | Presto | Existing bundled brand glyph |
| `elasticsearch` | Elasticsearch | Existing bundled brand glyph |
| `opensearch` | OpenSearch | Existing bundled brand glyph |
| `druid` | Apache Druid | Existing bundled brand glyph |
| `duckdb-file` | DuckDB database file | Existing bundled brand glyph |
| `parquet-folder` | Parquet files | Existing Apache Parquet glyph |
| `csv-folder` | CSV files | Add a local CSV format mark |
| `url` | URL / API (JSON) | Existing JSON glyph |

`csv-folder` is a file format rather than a vendor. It still receives a real
CSV document mark, never initials, so the 35-of-35 UI guarantee remains true.

## Home → Connect shortlist

Replace each `.as-dot` with a compact decorative logo host while preserving the
button labels and click behavior:

| Shortcut | Mark |
|---|---|
| CSV / Excel | Microsoft Excel/file mark |
| Paste data | Clipboard action mark |
| PostgreSQL | The same PostgreSQL mark used in the catalog |
| MySQL | The same MySQL mark used in the catalog |
| Screenshot | Capture-frame action mark |

Paste and Screenshot are local actions rather than external vendors, so they
use recognizable action pictograms. They are not counted among the 35 connector
coverage assertion.

The sidebar marks render at 18–20 px inside a fixed 22 px slot. They use no
background tile, keeping the narrow rail calm and aligned with the current text.
Brand marks retain safe brand color; action marks use `currentColor` and adapt
to light and dark themes.

## Architecture and data flow

`src/icons.ts` remains the single main-process source of renderer-safe logo
data. Existing Simple Icons are read from the committed JSON asset; local SVG or
PNG files in `renderer/hub/assets/connectors/` override or fill missing IDs and
are converted to `data:` URIs. `connector:logos` sends the structured-clone-safe
map through the preload.

The renderer keeps one logo-construction helper. The full picker passes catalog
IDs and labels to it. Home passes the PostgreSQL/MySQL IDs or a small set of
explicit action IDs. Both surfaces therefore share image loading, SVG creation,
decorative accessibility, and corrupt-image fallback behavior.

No secret, filesystem path, or remote URL crosses the preload boundary.

## Asset provenance

Manually bundled files must be sourced from official vendor sites, official
architecture icon packs, or the vendor's own source repository. AWS and Azure
assets come from their published architecture-icon collections. Each manually
added file is listed in a provenance document with its source URL, retrieval
date, original filename, and any stated usage terms.

Trademark assets remain separate third-party marks used only to identify their
corresponding connector. They are not relicensed as Ordinate artwork.

## Failure behavior

- Missing catalog coverage is a test/build failure, not a silent initial badge.
- A malformed local image swaps to deterministic initials at runtime so a bad
  asset cannot break the picker or selected-source header.
- The Home shortlist uses built-in SVG paths for action marks, so it has no
  image-load failure mode.
- The hub CSP remains unchanged and the renderer performs no logo fetch.

## Testing

### Focused self-check

- Load the live `connectorCatalog()` and `connectorLogos`.
- Assert the catalog contains exactly 35 unique IDs.
- Assert every catalog ID resolves to a non-empty SVG path or local `data:` URI.
- Assert there are zero missing IDs and logo payloads contain no remote or local
  filesystem paths.
- Assert the new manually bundled IDs resolve to their expected asset form.

### Real Electron smoke test

- Open the source catalog and assert all 35 tiles contain SVG or image marks.
- Assert no normal catalog tile has `.conn-logo-fallback`.
- Verify representative existing and new marks, including Redshift, Azure SQL,
  Oracle, StarRocks, and CSV.
- Verify the selected-source header repeats its mark.
- Preserve the corrupt-image fallback test.
- On Home, assert all five Connect shortcuts have logo hosts and no `.as-dot`.
- Capture and inspect light and dark screenshots.
- Continue failing on renderer errors and CSP violations.

## Out of scope

- Changing connector behavior, labels, ordering, or the 35-source count.
- Fetching or updating logos at runtime.
- Adding a general-purpose icon framework.
- Reworking the Home navigation layout beyond replacing the blue squares.
