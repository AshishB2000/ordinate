# Phase 3b — async bridge + typed views

**Status:** complete. Both blockers that stopped Phase 3 are gone.
**Branch:** `feat/phase-3b-async-views`, off `feat/phase-3-mosaic`.
**Tests:** `npm test` → **1,913 ok / 0 fail** (Phase 3 left it at 1,748; +165).

Phase 3 stalled on two things ([docs/phase-3](../phase-3/README.md) B3 and B4). This phase removes both. Neither is Mosaic-specific — both are worth having regardless of whether Mosaic ever ships.

---

## 1. B3 — the bridge no longer freezes the app

`src/duckdb.ts` blocks the Electron **main thread** on `Atomics.wait`. That is correct for batch compute — one metric, one aggregate, answer wanted on the next line, freeze measured in milliseconds. It is catastrophic for anything interactive: a brush drag issues queries every frame, and each one would freeze all five windows, the menu bar, and the global hotkey.

There is now a second path on the **same worker and same connection**:

```ts
query(sql, params)      / exec(sql)       // unchanged — batch compute
queryAsync(sql, params) / execAsync(sql)  // new — interactive, high-frequency
```

**The event-loop proof, measured directly rather than argued:**

| | call duration | event-loop ticks during the call |
|---|---:|---:|
| `query()` (sync) | 209 ms | **0** — a 2 ms timer and a `setImmediate` both failed to fire |
| `queryAsync()` | 213 ms | **168** — the 2 ms timer fired at 2.6 ms |

Independently reproduced: 0 ticks during a sync call, 3 during an async one on a shorter query.

**Async costs nothing.** Medians, Apple M4: trivial call 0.10 ms both paths; 10k-row group-by 0.40 sync / 0.39 async; a 10k-row full result is *faster* async (7.20 vs 8.16 ms — `postMessage`'s string clone beats the SAB memcpy plus `Buffer.toString`).

**Transferables do not help**, which is worth recording because it is counter-intuitive. Worker→main round trip including encode and decode:

| | 100k×5 | 1M×3 |
|---|---:|---:|
| post the JSON string | **29 ms** | **213 ms** |
| transfer an ArrayBuffer of the same JSON | 30 ms | 227 ms |
| `structuredClone({columns, rows})` | 43 ms | 409 ms |

The payload has to be built as a string anyway, so transferring only adds a UTF-8 encode and decode. One encoder, one decoder, both paths.

### Mixing sync and async does not deadlock

The ordering that looks fatal: an async call is in flight; the main thread then issues a sync call and parks in `Atomics.wait`. The worker finishes the async work and posts its reply — which *cannot be delivered*, because the main thread is not at its event loop. Then the worker dequeues the sync request, writes the SAB, and notifies. The main thread wakes, returns the sync rows, and drains the buffered async reply on its next turn. **The sync signal is what releases the async replies.**

Verified in both orders, with several async calls straddling a sync one, and with a sync call issued from inside an async continuation. No deadlocking order was found. The reverse ordering cannot arise — a single-threaded main cannot issue an async call while parked.

The invariant that makes this safe: **async replies never touch the control block or the payload SAB.** An async completion writing the control block would forge the parked caller's signal. The reply channel is chosen from the presence of an `id`, in one place.

Honest caveat: an async promise is only as timely as the main thread's next event-loop turn, so a long sync query *delays* every async promise behind it. Latency, not deadlock, inherent to sharing one thread.

### A process-abort landmine this change created

`Worker.terminate()` while an `@duckdb/node-api` native call is in flight **aborts the process** — `libc++abi: terminating due to uncaught exception of type Napi::Error`, exit 134, not a catchable JS error. Reproduced in ~15 lines with nothing from this codebase involved.

It was **unreachable before this phase**: a sync caller holds the main thread for the whole query, so `shutdown()` during one was impossible. `queryAsync` makes it reachable, and process exit around a live orphan triggers it identically.

Fix: `shutdown()` terminates only when idle. When busy it posts a `close` message, which lands behind the in-flight work in the same serialized queue and lets the worker exit itself once DuckDB is quiet. The worker stays `ref`'d until it actually goes, because an unref'd orphan still aborts at process exit. `shutdown()` remains synchronous and instant (asserted `< 20 ms` with a ~200 ms query in flight).

Residual risk, documented in the file: a **file-backed** DB restarted immediately after a busy shutdown could briefly race the old worker for the file lock. Theoretical today — the app uses `:memory:` plus `read_parquet`.

## 2. B4 — Parquet is now queryable with real types and real names

`parquetStore` stores every column VARCHAR with positional names `c0..cN`, and that is deliberate: it is what stops DuckDB's sniffer turning `007` into `7`. But it also means generated SQL sees nothing useful — `sum("revenue")` has no such column, and `DESCRIBE` reports VARCHAR for everything, so any charting layer gets only ordinal scales.

`src/datasetView.ts` projects a typed, user-named view over a stored file:

```sql
CREATE OR REPLACE VIEW "ds_x" AS SELECT
  CAST(c0 AS VARCHAR) AS "region",
  CAST(CASE WHEN isfinite(TRY_CAST(c1 AS DOUBLE)) THEN TRY_CAST(c1 AS DOUBLE) END AS DOUBLE) AS "revenue"
FROM read_parquet('…');
```

Verified end to end:

```
DESCRIBE ds_t  →  ["zip:VARCHAR", "revenue:DOUBLE"]
SELECT zip, sum(revenue) … GROUP BY zip  →  [{"zip":"00210","s":20},{"zip":"007","s":15}]
```

**Casting follows the DECLARED type, never inference.** Only a `number` column is cast. A `text` column is never `TRY_CAST` — `TRY_CAST('007' AS DOUBLE)` is `7`, the exact bug the storage design exists to prevent. `sum()` over a text column is a loud binder error rather than a silently wrong number.

`date` deliberately stays VARCHAR: Ordinate's `date` is a *detected display type* over a verbatim stored string, and `'not a date'` is a legal cell in such a column. A `DATE` cast would either null it or reformat it.

### Identifier safety

- **Quoting** is `"…"` with embedded `"` doubled — that is the whole escape. Verified inert against a column name crafted as `evil"; DROP VIEW <sentinel>; SELECT ' --`: the sentinel view survives and the hostile name is stored verbatim as a single identifier.
- **De-duplication** is first-wins with `_1`, `_2` suffixes, compared **ASCII-case-insensitively** because DuckDB's identifier equality is. Measured: `"a"`/`"A"` collide; `"É"`/`"é"` and `"İ"`/`"i"` do not. `String.toLowerCase()` folds `İ`→`i` and would invent collisions the engine does not have, so the fold is hand-rolled ASCII-only.
- A test asserts `DESCRIBE` equals `viewColumns()`, so a silent engine-side rename cannot hide.
- **View names are validated, never constructed** (`/^[A-Za-z_][A-Za-z0-9_]{0,127}$/`). A raw UUID is rejected; the caller maps it.

### Cross-checked against an independent implementation

A `GROUP BY` + `sum` through the view was compared against `residentQuery.aggregateResident` on the same file — two independently written SQL paths, 6 groups, every sum identical, over a fixture with negatives, a zero, a null measure, `1e9`, an `''` category and a `null` category.

## 3. Known limitations

- **A leading U+FEFF in a column *name* survives in the view but is lost on `DESCRIBE` read-back**, because the bridge's transport strips one leading BOM from every returned string (the upstream `@duckdb/node-api` bug documented in Phase 2, now confirmed on *both* transport paths). A consumer discovering names via `DESCRIBE` instead of `viewColumns()` would emit an identifier that does not bind. `parse.ts` does not strip a BOM from a CSV header, so this is reachable from a real file. Nothing is mangled to paper over it; the fix belongs upstream.
- **View *values* inherit the same transport loss.** `parquetStore.readTable` can apply its `bomSafe` doubling because it is a read-into-JS function; a VIEW is a stored SQL object, and doubling there would corrupt the value for every in-SQL comparison, filter and `GROUP BY`. Deliberate.
- **Empty and NUL-bearing column names are replaced wholesale** by `column_<n>`. DuckDB rejects the empty identifier outright and a NUL cannot cross the binding's C strings.
- **`a` and `A` cannot coexist**; the second becomes `A_1`.

## 4. What this unblocks

Phase 3's remaining work is now unobstructed on the two counts that were architectural:

- **B3 gone** — interactive queries no longer freeze the app, so Mosaic's interactors are viable.
- **B4 gone** — Mosaic's generated SQL can hit a typed, user-named view.

Still outstanding from Phase 3, both build-level rather than architectural: **B1** (a build-time vendor bundle, because vgplot is 1,039 ESM modules) and **B2** (mirror Observable Plot's ruleset into `hub.css` so its injected `<style>` does not need a CSP change). And the 5 chart GAPs remain a product decision, with Chart.js retained for them either way.
