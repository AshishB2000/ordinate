# Phase 6 · 01 — The compute engine and the Node runtime under Tauri (landmine 6.5)

**What this is.** The one question none of the sibling passes own: **what happens to DuckDB.**
`@duckdb/node-api` is a Node N-API module driven from a worker thread, with the main thread blocked
on `Atomics.wait` over a growable `SharedArrayBuffer` so that a synchronous API can exist. Tauri has
no Node runtime, so none of that survives contact. This document states the contract that bridge
exposes in full, weighs the three ways out, prices each one, and reaches a verdict on the engine's
own evidence.

**What this is not.** Not the capture loop (landmine 6.3), not the export stack (landmine 6.4), not
the IPC port, the security model, or the shell-level size arithmetic — the process-model pass owns
all of those and this document does not redo them. Where a claim of theirs bears on the engine it is
cited, not restated.

**Prior art this builds on, and does not redo:**
[`docs/phase-6/04-process-model-and-verdict.md`](./04-process-model-and-verdict.md) — the
Electron→Tauri construct table (§1.1), the security scorecard (§2.1), the IPC mapping (§1.3–1.5),
the measured install/download sizes (§5.1–5.2), the "one architectural win, and it is free" section
(§5.3), the extension-download risk (§5.4), and the **close Phase 6** verdict (§7).
[`docs/phase-6/03-export-stack.md`](./03-export-stack.md) — the rejection of a bundled *Node*
sidecar for the export libraries (§2.0 strategy C), and the "keep the TS as the differential
reference" pattern (§4.2). [`docs/phase-6/02-capture-and-shell.md`](./02-capture-and-shell.md) —
the window model. Doc 04 §7.2 item 4 endorses a DuckDB sidecar **with no cost attached to it**; §4
below is that costing. Doc 04 §5.2 puts a static Rust link at "REASONED: 50–90 MiB per
architecture"; §2.3 below replaces that range with a measurement.

**Status of the source read.** Worktree `/Users/ashishb/Projects/ordinate-phase6`, branch
`feat/phase-6`, at `610e4b5`. Read-only on code — this file is the only thing this pass wrote, and
nothing was committed. Files read in full: `src/duckdb.ts` (732), `src/duckdbWorker.ts` (301),
`src/parquetStore.ts` (340). Read in part: `src/residentQuery.ts`, `src/statsResident.ts`,
`src/anomaliesResident.ts`, `src/datasetPage.ts`, `src/datasetView.ts`, `src/sqlGen.ts`,
`src/pipelineDuck.ts`, `src/ipc/mosaic.ts`, `src/ipc/dashboards.ts`, `src/connectionRun.ts`,
`src/parseXlsx.ts`, `src/icons.ts`. **Rust is not installed on this machine and was deliberately not
installed.** Nothing Rust was compiled, linked, or benchmarked.

---

## 0. Epistemic status — read this first

Same three labels as doc 04, so the numbers below are directly comparable with its §5.

| Label | Means |
|---|---|
| **MEASURED** | Produced in this pass by running something on this machine — the test suite, `lipo`/`strip`/`nm` on the shipped dylib, a purpose-built stdio benchmark — or read off files in this checkout. Numbers, not behaviour. |
| **MEASURED-IN-REPO** | A number the repository already carries in a source comment or a `docs/phase-N` file, produced by an earlier phase's spike. Not re-measured here; cited to its file. |
| **RESEARCHED** | Taken from upstream documentation or a cited source. Sources in §9. |
| **REASONED** | Inference from the above. Could be wrong. A range is honest uncertainty, not a hedge. |

Nothing in this document is **verified**. Verifying the Rust half would require installing a Rust
toolchain and compiling DuckDB, which was explicitly out of bounds; verifying the sidecar half would
require building one. §8.2 says which of the unverified claims would actually change the verdict if
they came out the other way, and §8.3 lists the two cheap experiments that would settle them.

### 0.1 Verdict at a glance

| | |
|---|---|
| **Recommendation** | **Agree with doc 04: close Phase 6.** Not on shell grounds — on the engine's own. |
| **The engine contributes nothing to the case for Tauri** | DuckDB is ~46–55 MiB of native code under *either* shell (§2.3, MEASURED). It is arch-invariant across runtimes. The size delta Tauri buys on the compute axis is approximately **zero**. |
| **The one real win is real, and does not need Tauri** | Deleting the `Atomics.wait`/`SharedArrayBuffer` bridge — 534 lines of the most delicate code in the repo — is worth doing. §4 prices a sidecar that gets it for a fraction of the cost (MEASURED: transport tax **0.07 ms** on a real Explore page). |
| **LOC genuinely at stake** | **2,621 lines of code** in the DuckDB layer (5,500 physical lines, 48% of which is comment), plus **2,054 lines** of pure-JS reference implementation whose fate is the actual argument. |
| **Test-suite consequence** | **1,648 of 3,285 assertions (50.2%) do not execute at all without a live DuckDB engine** (MEASURED, §7.2). They are not merely ported — the differential half of most of them stops existing. |
| **The IPC surprise** | The boundary a sidecar *adds* costs **0.08 ms** on a real Explore page (MEASURED). The webview↔Rust boundary a Tauri port *keeps* has a **~300 µs–1 ms floor** and ~6.7 ms at 64 KB of JSON (RESEARCHED, third-party) — against queries measured at 2–12 ms (§4.3). |
| **Newly found blockers for brief §6.5** | The DuckDB connection is deliberately hardened with `lock_configuration=true`, making `INSTALL`/`LOAD` a permission error **irreversibly, process-wide** (§2.2, MEASURED). And `ATTACH` of a Postgres database **segfaults from `duckdb-rs`** — filed, closed `not_planned`, no fix (§6.2, RESEARCHED). |
| **One thing nobody has done** | The U+FEFF bug has **never been reported upstream** (§1.5, verified negative search). "Upstream won't fix it" is currently an assumption, and filing it costs minutes. |

---

## 1. The exact contract `src/duckdb.ts` exposes

Anything that replaces this file has to satisfy all of it. This section is the specification, taken
from the source rather than from the docs.

### 1.1 The exported surface

Ten exports. Six are the API; four are diagnostics and lifecycle. [MEASURED — `src/duckdb.ts`]

| Export | Kind | Signature | Notes |
|---|---|---|---|
| `query` | **sync, blocking** | `(sql, params?) => DuckRow[]` | Blocks the calling thread in `Atomics.wait`. The primary path. |
| `exec` | **sync, blocking** | `(sql) => void` | DDL/DML. Takes no parameters by contract — `exec` is app-generated SQL. |
| `queryAsync` | async | `(sql, params?) => Promise<DuckRow[]>` | Same worker, same connection, same bytes. Reply by `postMessage`. |
| `execAsync` | async | `(sql) => Promise<void>` | Non-blocking twin of `exec`. |
| `isAvailable` | **sync, blocking** | `() => boolean` | Starts the worker on first call, so it genuinely blocks (~115 ms cold). Never throws. |
| `configure` | sync, pure | `(DuckDBOptions) => void` | `dbPath`, `initialBytes` (1 MiB), `maxBytes` (512 MiB). Throws `config` if the bridge is already up. |
| `shutdown` | sync | `() => void` | Idempotent. **Settles** every in-flight promise rather than abandoning it. |
| `lastCallMicros` | sync | `() => number` | Worker-side µs of the last **sync** call, read out of the control block. |
| `lastAsyncCallMicros` | sync | `() => number` | Worker-side µs of the last **async** call, carried in the reply message. Deliberately separate. |
| `DuckDBError` | class | `{ code: DuckErrorCode }` | Five codes, §1.4. |

Types: `DuckValue = string | number | null`, `DuckRow = { [col: string]: DuckValue }`. Nothing else
crosses. A `boolean` cannot cross; a `bigint` cannot cross; a `Date` cannot cross. `checkParams`
rejects anything that is not a string, number, or null with a `query` error rather than
stringifying it into SQL.

**Nine call sites in `src/`, in nine modules, 41 references.** [MEASURED]
`parquetStore` (7), `ipc/mosaic` (8, **async only, by contract**), `pipelineDuck` (5), `datasetPage`
(5), `statsResident` (4), `anomaliesResident` (4), `datasetView` (4), `residentQuery` (3),
`datasets` (1). `worker_threads`, `SharedArrayBuffer` and `Atomics` appear **nowhere else in the
codebase** — the mechanism is entirely contained in these two files. [MEASURED — grep across `src/`,
`preload/`, `scripts/`, `main.ts`]

### 1.2 The mechanism, precisely

```
  main thread                          worker thread
  ───────────                          ─────────────
  ctl[0] = PENDING
  worker.postMessage({sql, params}) ─▶ runAndReadAll(sql, params)
  Atomics.wait(ctl, 0, PENDING)        encode payload → SharedArrayBuffer
       ⟵ unblocks ⟵                    ctl[0] = OK; Atomics.notify(ctl, 0)
  read bytes out of the SAB, parse
```

- **Control block**: `Int32Array(4)` over a 16-byte `SharedArrayBuffer`. Slot 0 = signal
  (`0 PENDING / 1 OK / 2 ERROR / 3 OVERFLOW`), 1 = payload length, 2 = bytes needed on overflow,
  3 = worker-side elapsed µs.
- **Payload buffer**: a **growable** `SharedArrayBuffer` (ES2024 `{ maxByteLength }`), 1 MiB initial,
  512 MiB ceiling, grown in place by the worker with the growth visible on both threads without a
  re-post. A runtime without growable SABs falls back to allocating the ceiling up front.
- **Wire format**: columnar UTF-8 JSON, `{columns: string[], rows: DuckValue[][]}`. One encoder
  (`encodeText`, worker) and one decoder (`decodeRows`, main), deliberately isolated so an
  Arrow/columnar payload could replace both without touching either transport.
- **The two channels are chosen by the presence of an `id`** on the request message, in one place.
  An async reply must never touch the control block, because a sync caller may be parked on it and
  an async completion writing it would forge that caller's signal. The header calls this out as the
  single thing that would break the design.
- **Serialization**: the worker chains every request through one promise queue, itself chained off
  the init handshake, so nothing can be handled before the connection exists and two sync calls can
  never race the single control block.
- **Spurious wakeups** are handled: `block()` loops until the signal actually moves off `PENDING`
  or the deadline passes.
- **Timeouts**: 20 s startup, 120 s per call. A sync timeout **tears the bridge down**, because a
  wedged worker might still write the shared buffer later and corrupt a subsequent call. An async
  timeout does not, because a late reply carries an id nobody holds.
- **`Worker.terminate()` during a live native call aborts the process** — `libc++abi: terminating
  due to uncaught exception of type Napi::Error`, not a catchable JS error. Reproduced in the repo
  in ~15 lines. So `shutdown()` on a busy worker posts a `{kind:'close'}` message through the same
  serialized queue and waits, with deliberately **no terminate backstop**. [MEASURED-IN-REPO —
  `src/duckdb.ts:336-381`]

**Measured properties of this transport**, all MEASURED-IN-REPO from earlier phases:

| | |
|---|---|
| Worker cold start (native load + connect + `SELECT 1`) | ~115 ms (`duckdb.ts:114`) |
| Per-query SAB handshake | ~0.5 ms (`src/ipc/dashboards.ts:53`) |
| SAB memcpy, 100k-row result | ~0.83 ms (`duckdb.ts:100`) |
| Async transport, JSON string via `postMessage` | 29 ms (100k×5) / 213 ms (1M×3) — **chosen** |
| Async transport, transferred `ArrayBuffer` of the same bytes | 30 ms / 227 ms — no help |
| Async transport, `structuredClone` of `{columns,rows}` | 43 ms / 409 ms — 1.5–1.9× slower, rejected |
| Event-loop ticks during a sync call | **0** (docs/phase-3b §1) |

That last row is the whole reason `queryAsync` exists: Mosaic issues queries at animation-frame rate
during a brush drag, and a sync call there would freeze all five windows, the menu bar and the
global hotkey on every frame.

### 1.3 The type mapping, and the BigInt decision

Decided in `duckdbWorker.ts`, visible to every caller. A **whole column** is typed the same way
regardless of the magnitude of individual rows, so downstream code never sees a column that is
`number` for small rows and `string` for big ones.

| DuckDB type | `DuckValue` |
|---|---|
| TINYINT…INTEGER, FLOAT, DOUBLE | `number` |
| DECIMAL | `number` (may round past ~15 significant digits) |
| **BIGINT / UBIGINT / HUGEINT / UHUGEINT / BIGNUM** | **`string`** — a decimal string |
| BOOLEAN | `'true'` / `'false'` (the workspace has no boolean cell type) |
| DATE / TIME / TIMESTAMP(+TZ) / UUID / BLOB / ENUM / BIT | `string` |
| INTERVAL / LIST / STRUCT / MAP / UNION / ARRAY / GEOMETRY / VARIANT | `string` (JSON text) |
| NULL | `null` |

**The BigInt rule is load-bearing and a Rust port inherits it, not avoids it.** `SUM(INTEGER)` in
DuckDB is HUGEINT; the naive paths (`Number(bigint)`, the CLI's `-json`) silently round past 2^53 —
the spike caught `9007199254740993` becoming `…992`. The bridge therefore refuses to decide, and the
resident layer's rule is "every aggregate is `CAST(… AS DOUBLE)`", applied at the SQL site. In Rust
the same decision recurs one layer down: `i128`/`Decimal` still has to become something the webview
can hold, and JSON over Tauri's IPC has the same 2^53 problem JSON over `postMessage` has. **The
BigInt hazard is a property of the JS consumer, not of the Node binding**, so it survives every
option in §3–§5. [REASONED]

### 1.4 Errors, and the never-fatal rule

Five codes on one typed error class: `unavailable`, `query`, `overflow`, `timeout`, `config`.

The contract that matters is not the taxonomy, it is this: **the bridge is never fatal.** If the
worker or the native binding fails to load, `isAvailable()` returns `false` and every call throws a
catchable `DuckDBError` — and every module above it treats that as "use the pure-JS path". Every
resident entry point (`computeMetricResident`, `aggregateResident`,
`computeColumnSummariesResident`, `findQualityIssuesResident`, `sampleRowsResident`,
`detectAnomaliesResident`, `readPage`, `readDistinct`, `ensureView`) returns `null` rather than
throwing. `parquetStore.readTable` returns `null` on a missing, truncated, or non-Parquet file so a
corrupt record is skipped rather than fatal — while `writeTable` **does** throw, because a failed
save must be visible.

This is the property §7 turns on. It is also the hazard the repository already names: a broken fast
path is not *wrong*, just slow, which is why every one of these modules is paired with a
differential test.

### 1.5 The U+FEFF transport bug

[MEASURED-IN-REPO — `src/duckdb.ts:76-92`, `src/parquetStore.ts:211-233`, pinned by
`scripts/test-duckdb.ts`]

A **leading** U+FEFF is lost from every returned string, on **both** paths. `SELECT chr(65279) ||
'x'` has `length() = 2` inside DuckDB and arrives in JS as `'x'`. A BOM anywhere other than position
0 survives; a doubled leading BOM arrives as a single one.

Three facts about it that matter for a port:

1. **It is not the transport's doing.** Every accessor `@duckdb/node-api` exposes — `getRowsJson`,
   `getRows`, `getColumnsJS`, `getRowObjects` — strips it identically. The loss is below the JS
   layer in the binding, so it cannot be fixed by switching accessor or by post-processing: by the
   time a string reaches JS there is no way to know a BOM was ever there.
2. **The Parquet file is faithful.** The corruption is on read-back only.
3. **The workaround is in SQL, at projection time, in exactly one place.** `parquetStore.readTable`
   projects `CASE WHEN starts_with(v, chr(65279)) THEN chr(65279) || v ELSE v END` — doubling a
   leading BOM so the transport's strip is an exact inverse. It is applied because *storage fidelity
   is non-negotiable*; `pipelineDuck` does **not** apply it, so the default-off SQL pipeline path
   would round-trip a BOM-leading text cell lossily.

**It has never been reported upstream.** [RESEARCHED — a thorough negative result, this pass: GitHub
issue search on `duckdb/duckdb-node-neo` for `BOM OR FEFF OR "byte order mark"` returns **0**; an API
search over the same repo for `BOM|FEFF|unicode|"zero width"` returns **1**, an unrelated
`getRowObjects` perf PR; all 34 issues there matching `varchar|string|utf8` were enumerated and none
concerns string corruption. A cross-repo title search over `duckdb/duckdb`, `duckdb-node` and
`duckdb-node-neo` finds 4 BOM issues, **all closed and all in core, all about *readers*** — CSV and
JSON ingest — not about the C API's string return.]

**For the port question this bug cuts two ways, and the honest reading is that it is a weak argument
for a rewrite.** It is a genuine defect in a dependency, and doc 04 §7.3 correctly lists "its BOM
bug and missing Arrow support start costing real work" as a condition that reopens the phase. But it
has already cost the work: the fix is 3 lines of SQL in one function, it is exact rather than
heuristic, and it is pinned by a test so it stays visible. A Rust port would delete `bomSafe` — and
would need its own test proving the BOM survives, because "the new binding does not have the old
binding's bug" is a claim, not a fact until something asserts it. [REASONED]

And the "nobody upstream will fix it" half of doc 04 §7.3's condition is currently **untested**: the
bug has not been reported, so nobody upstream has declined to fix it. There is precedent for BOM
fixes landing in core (`duckdb#2908`, `duckdb#16568`, PR #1573). Filing it is minutes of work and is
the cheapest possible experiment on that reopening condition — §8.3 E4.

### 1.6 The eleven invariants a replacement must satisfy

Extracted from the source as a checklist, because "port `duckdb.ts`" is not a task until this list
is enumerated.

| # | Invariant | Where it comes from |
|---|---|---|
| 1 | A **synchronous** query API exists and returns rows on the next line | `query`/`exec`; 9 modules depend on it |
| 2 | A **non-blocking** API exists on the **same connection**, and interleaving the two cannot deadlock or cross-talk | `queryAsync`/`execAsync`; `ipc/mosaic.ts` is async-only by contract |
| 3 | Failure is **never fatal** — a typed, catchable error and an `isAvailable()` probe | §1.4; every resident module's `null` return |
| 4 | Parameters are **bound**, never interpolated; non-scalars are rejected at the boundary | `checkParams`; the same invariant as `connectionRun.ts` |
| 5 | 64-bit-and-wider integers arrive as **decimal strings**, per column, never as rounded numbers | §1.3 |
| 6 | A result-size **ceiling** exists and is reported identically on both paths (`overflow`, with the byte count needed) | 512 MiB default; `handleAsync` re-applies it even without a buffer |
| 7 | Nothing is left pending: worker death, wedge, and `shutdown()` all **settle** every in-flight promise | `settleAllPending` |
| 8 | The engine is **lazy** — importing starts nothing; a cold start from an async caller never blocks | `ensureStartedAsync`, `state: 'starting'` |
| 9 | Shutdown never aborts the process mid-native-call | `closeWorker`, the `Napi::Error` reproduction |
| 10 | `null` and `''` stay distinguishable end to end | `transforms.isEmptyCell` depends on it; `parquetStore` enforces it |
| 11 | Diagnostic worker-side timing is available separately per path | `lastCallMicros` / `lastAsyncCallMicros`; the benchmarks read them |

Invariants 1, 2, 8 and 9 exist **only because the binding is async-only and lives in Node.** They
are the ones a Rust rewrite genuinely deletes (§3.2). Invariants 3–7, 10 and 11 are properties of
*this application*, and every option in §3–§5 has to reimplement all of them.

---

## 2. What actually sits on the bridge

### 2.1 The layer, measured

`wc -l` overstates this codebase badly, because the DuckDB layer is **48% comment** — it is where
the repository records its measurements. Both numbers are given; the code column is the one that
matters for a port estimate. [MEASURED]

| Module | physical | **code** | comment | What it is |
|---|---:|---:|---:|---|
| `src/duckdb.ts` | 732 | **364** | 316 | The bridge |
| `src/duckdbWorker.ts` | 301 | **170** | 104 | The worker half |
| `src/parquetStore.ts` | 340 | **172** | 134 | Table storage: `COPY … TO … (FORMAT PARQUET)` + NDJSON load |
| `src/sqlGen.ts` | 466 | **299** | 123 | `TransformStep[]` → CTE chain. Pure string builder, no binding |
| `src/pipelineDuck.ts` | 179 | **86** | 74 | Runs the CTE chain. **Off by default** |
| `src/residentQuery.ts` | 497 | **234** | 212 | Metrics + chart aggregates off Parquet |
| `src/statsResident.ts` | 555 | **252** | 255 | All column summaries in one statement |
| `src/anomaliesResident.ts` | 870 | **405** | 395 | The anomaly detector's aggregates |
| `src/datasetPage.ts` | 635 | **286** | 291 | One paged/searched/sorted grid window |
| `src/datasetView.ts` | 300 | **90** | 187 | Typed, user-named `VIEW` over the positional store |
| `src/ipc/mosaic.ts` | 625 | **263** | 313 | The dark Mosaic channel + the engine hardening |
| **Total** | **5,500** | **2,621** | **2,404** | |

And the code it must agree with — the pure-JS reference implementations, which are **not** part of
the DuckDB layer and are the subject of §7:

| Module | physical | **code** | Reference for |
|---|---:|---:|---|
| `src/transforms.ts` | 696 | **553** | `pipelineDuck` / `sqlGen` |
| `src/formula.ts` | 1,043 | **875** | the calculated-field evaluator (no SQL twin exists) |
| `src/metricValue.ts` | 80 | **48** | `residentQuery.computeMetricResident` |
| `src/vizData.ts` | 270 | **190** | `residentQuery.aggregateResident` |
| `src/datasetStats.ts` | 162 | **120** | `statsResident` |
| `src/anomalies.ts` | 358 | **268** | `anomaliesResident` |
| **Total** | **2,609** | **2,054** | |

Plus `datasetPage.pageRowsJs` — the reference for `readPage`, exported from the same file precisely
so there is one reference implementation and not two.

### 2.2 The engine is already hardened, irreversibly — and this kills brief §6.5

[MEASURED-IN-REPO — `src/ipc/mosaic.ts:73-120`, every line of it measured against DuckDB v1.5.5 on
this build and pinned by `scripts/test-mosaicIpc.ts`]

Phase 3c shipped a real security control on the DuckDB connection, applied once and lazily:

```
SET allowed_directories=['<userData>'];   -- MUST come first
SET enable_external_access=false;
SET lock_configuration=true;
```

After those three, measured on this build: `read_csv('/etc/hosts')`, `COPY … TO '/tmp/x.csv'`,
`INSTALL httpfs`, `LOAD httpfs` and `ATTACH '/tmp/x.db'` are all Permission Errors, while
`read_parquet` and `COPY … TO` under `userData` still work. The ordering is load-bearing and not
obvious: set it the other way round and it enforces nothing while looking applied.

Two consequences the port question has to absorb:

1. **The blast radius is the whole process** — there is one DuckDB connection, so the lock applies to
   `residentQuery`, `statsResident`, `parquetStore`, `pipelineDuck` and everything else — and
   `lock_configuration` is **irreversible for the life of the process** ("Cannot enable external
   access while database is running").

2. **Brief §6.5's premise does not survive it.** The brief proposes replacing `pg` and `exceljs` with
   DuckDB's `postgres` and `excel` extensions. Both are loadable extensions. `LOAD` is a permission
   error under the shipped hardening, and cannot be re-enabled at runtime. So brief §6.5 requires
   either statically linking those extensions into the binary (doc 04 §5.4 flags this and leaves the
   size open), or **unwinding a shipped security control to save a dependency** — and the control
   exists because DuckDB "is not merely a calculator: it can read and write the filesystem, attach
   databases, and install/load extensions, which is native code execution."

   This is a stronger objection than doc 04 §5.4's, which was about a silent first-use network fetch
   to `extensions.duckdb.org` violating invariant 9. That is true and remains true. But even with
   the extensions bundled and the network fetch eliminated, **the app's own lock still blocks
   `LOAD`**, and a statically linked extension that is auto-registered rather than `LOAD`-ed
   sidesteps the lock rather than satisfying it. [MEASURED for the lock's behaviour; REASONED for
   the static-linking interaction, which was not tested and cannot be without a Rust toolchain.]

   `pg` is 140 KB on disk. It is not worth this. (§6.2.)

### 2.3 The size of the engine, measured — and doc 04's 50–90 MiB range is too wide

This is the number doc 04 §5.2 flagged as its least-supported (`REASONED: 50–90 MiB per
architecture`). It can be bounded much more tightly without a Rust toolchain, by measuring the
artifact that is already on disk. [MEASURED — `lipo`, `strip`, `nm`, `stat` on
`node_modules/@duckdb/node-bindings-darwin-arm64/libduckdb.dylib`, DuckDB v1.5.5,
`@duckdb/node-api` 1.5.5-r.3]

**Finding 1 — the "arm64" dylib is a fat binary containing both architectures.**

```
$ lipo -info libduckdb.dylib
Architectures in the fat file: … are: x86_64 arm64
    x86_64   59,743,808 B   57.0 MiB
    arm64    57,236,352 B   54.6 MiB
    fat     117,005,184 B  111.6 MiB
```

The package is *named* `@duckdb/node-bindings-darwin-arm64`. Its `duckdb.node` shim (425,448 B) is
genuinely arm64-only. The 112 MiB dylib inside it is not — **more than half of it is dead x86_64
code on an Apple Silicon machine.**

**Finding 2 — the shipped arm64 app carries four DuckDB slices where it needs one.**

```
dist/mac-arm64/…/node_modules/@duckdb/node-bindings-darwin-arm64/libduckdb.dylib  117,005,184  (fat)
dist/mac-arm64/…/node_modules/@duckdb/node-bindings-darwin-x64/libduckdb.dylib    117,005,184  (fat)
```

Doc 04 §5.1 measured both files and correctly totalled DuckDB at **224 MB / 40% of the install**. The
cause it diagnosed — `predist:mac` running `npm i --force --no-save @duckdb/node-bindings-darwin-x64`
and `files: ["**/*"]` sweeping it in — is confirmed by `package.json`. What the fat-binary finding
adds is that **the waste is larger than doc 04 could see, and one of its two proposed fixes is
insufficient**:

| | MiB |
|---|---:|
| DuckDB in the arm64 install today | 223.2 |
| …actually needed on arm64 | 54.6 |
| **Dead DuckDB in the arm64 install** | **168.6** |

Doc 04 §7.2 item 1 ("split arm64/x64 DMGs") recovers ~112 MiB of that. Recovering the remaining
~57 MiB needs a second, equally cheap step: `lipo -thin arm64` on the dylib in `afterPack`, which
the repo already has a hook for (`scripts/afterPack.ts` already shells out to `clang` and `lipo` is
the same class of operation). The universal DMG is a different case and is **correct** as built — it
ships exactly one fat dylib, which is what universal means.

**Finding 3 — the floor for a single-architecture DuckDB is ~46 MiB, not 50–90.**

```
arm64 slice, as shipped                       57,236,352 B   54.6 MiB
arm64 slice, strip -S -x                      47,960,800 B   45.7 MiB
  (130,119 symbols in the fat binary; 35,088 exported)
arm64 slice, stripped then gzip -9            15,821,529 B   15.1 MiB
```

**What this means for the Tauri question.** A Rust build with the `duckdb` crate's `bundled` feature
statically links the same engine. Static linking with dead-code elimination should beat an
unstripped dylib with a 35,088-entry export table, but DuckDB's function and extension registries
are populated by static initializers, which is precisely the pattern that defeats `--gc-sections`.
So the realistic range is **~40–55 MiB per architecture** — bounded above by the measured stripped
dylib and below by however much DCE actually reaches. [MEASURED for the 45.7 MiB; REASONED for the
DCE behaviour, which was not tested.]

> **The engine costs the same under both shells.** A correctly packaged Electron arm64 build carries
> ~54.6 MiB of DuckDB (or 45.7 MiB stripped). A Tauri arm64 build carries ~40–55 MiB. **On the
> compute axis, the size delta between the two shells is somewhere between zero and 15 MiB, and the
> sign is not certain.** Every megabyte doc 04 §5.2 attributes to Tauri comes from the Electron
> framework and the asar, not from here.

This does not contradict doc 04's arithmetic; it removes DuckDB from the credit side of it. And it
strengthens doc 04 §7.2 item 1 from "~112 MiB installed for one line of config" to "**~169 MiB
installed for one line of config plus one `lipo` call**" — which is, on its own, more than half of
what doc 04 §5.2's "full Tauri port" row claims for the *entire* rewrite.

---

## 3. Option (a) — the Rust rewrite

### 3.1 What the `duckdb` crate actually gives

[RESEARCHED live in this pass — crates.io API, the crate's own `Cargo.toml` on `main`, docs.rs, the
DuckDB v1.5.5 release asset manifest, and the duckdb-rs issue tracker. URLs in §9. **Nothing was
compiled.**]

The crate is in better shape than doc 04's summary suggests, and that is worth stating plainly
before arguing against the port.

| | |
|---|---|
| **Version / engine** | `duckdb 1.10505.0`, published **2026-07-22**, tracking **DuckDB 1.5.5** — the exact engine this app runs today. MSRV 1.85.1, MIT, 3.1 M all-time downloads |
| **Governance** | Official: `github.com/duckdb/duckdb-rs`, "maintained by the Stichting DuckDB Foundation", listed in DuckDB's own Client APIs docs |
| **Upstream lag** | **0–1 days** across the last five releases (1.5.5: same day; 1.5.4: same day; 1.5.3: +1; 1.5.2: +1), and a parallel LTS line on 1.4.x. This removes "the binding will fall behind" as a risk |
| **API shape** | rusqlite-inspired: `Connection::open`/`open_in_memory`, `prepare`, `execute`, `query_map`, `params!`, `Transaction`, `Appender` |
| **Sync?** | **Fully synchronous and blocking. There is no async API** — an issue-title search for `async OR tokio` on the repo returns **zero results**, not even a request. `Connection` is `Send` but not `Sync`; the recommended multithreaded pattern is the `r2d2` feature, one connection per thread |
| **Arrow** | `query_arrow()` yields `arrow::record_batch::RecordBatch`. **`arrow` is a non-optional dependency** — always compiled in. Plus `vtab-arrow` (query an in-memory RecordBatch as a table), `appender-arrow`, and a `polars` feature |
| **Value typing** | `duckdb::types::Value` is a full enum with **`HugeInt(i128)`, `UHugeInt(u128)`, `Decimal`** as native variants |

**Three things about the build that a port plan has to price and doc 04 did not.**

1. **`parquet` implies `bundled`.** In the crate's `Cargo.toml`, `parquet = ["libduckdb-sys/parquet",
   "bundled"]` and `json` likewise. This app *is* Parquet, so the from-source C++ compile is not
   optional unless you link a prebuilt libduckdb yourself. Reported build times for
   `libduckdb-sys` with `bundled`: **~3–4 minutes on an M1**, and **>15 minutes / effectively hung
   on a 2019 Intel MacBook Pro** (duckdb-rs issue #180); an earlier issue put `libduckdb-sys` at
   ~60% of total project build time. `bundled` needs a C++ compiler only (it uses the `cc` crate on
   an embedded amalgamation); the newer `bundled-cmake` — merged 2026-04-10, still marked
   experimental — additionally needs cmake and a DuckDB git checkout, and is what unlocks
   statically linked extensions. **This is the number that determines whether CI stays usable**
   (§7.3).

2. **There is no `httpfs` feature, by design** (issue #352 / PR #353: "httpfs is not bundled in any
   other clients"). And **ICU is deliberately unbundled** (issue #464, 2025-03-12, "Unbundle ICU
   again due to binary size" — it pushed the crate over crates.io's 10 MB package limit), so ICU
   requires the experimental `bundled-cmake`. ICU backs collation and some timestamp handling; an
   engine without it is not obviously identical to the one this app ships against.

3. **The static-library sizes corroborate §2.3's measurement.** From the DuckDB v1.5.5 release
   manifest: `static-libs-osx-arm64.zip` = 26,256,428 B compressed, and
   `duckdb_cli-osx-arm64.zip` — an entire statically-linked CLI — = 17,005,846 B compressed. This
   pass measured the shipped arm64 dylib slice, stripped and gzipped, at **15,821,529 B**. Two
   independent artifacts landing within 8% of each other is a strong cross-check that the
   uncompressed single-arch engine is **~45–55 MiB whether it arrives as a dylib or as a static
   link**, and that doc 04 §5.2's upper bound of 90 MiB was too generous.

**The Arrow asymmetry is real and is the strongest single point in favour of a Rust engine.**
`@duckdb/node-api`'s Arrow issue ([duckdb-node-neo#45](https://github.com/duckdb/duckdb-node-neo/issues/45))
was opened **2024-11-03**, is assigned, is milestoned to "C API Parity", and has **no linked branch
or PR after 21 months**. It is not going to land on its own. §8.2 item 3 says when that starts to
matter; today it does not, because the resident layer is built so that nothing large crosses.

### 3.2 The sync bridge does simply vanish — say it plainly

**Yes. It vanishes, and this is the strongest single argument anywhere in Phase 6.**

Stronger, in fact, than "it vanishes": **the pattern is spec-prohibited in the place a naive port
would put it.** The main thread of a browser document has `[[CanBlock]] = false`, and `Atomics.wait`
in such an agent throws a `TypeError`. That is the ECMAScript agent model, not a vendor quirk — it
holds identically in WKWebView, WebView2 and WebKitGTK, and the proposal to change it
(`shared-everything-threads/WaitOnMainThread.md`) is still a proposal. `SharedArrayBuffer` itself
*is* available in a Tauri webview — Tauri 2.1.0+ exposes `app.security.headers` and the docs' own
worked example is COOP/COEP `same-origin` + `require-corp` "to allow for the use of
`SharedArrayBuffer`" — but it is useless for the job: Tauri's maintainers closed a 2023 proposal to
use SAB for IPC as a category error, because SAB bridges frontend JS ↔ *its own workers*, never
frontend ↔ Rust. [RESEARCHED — V8 atomics docs, the TC39 `waitAsync` proposal, Chromium
issue 41476333, Tauri HTTP-headers docs, tauri-apps discussion #6269.]

So the design works today for one reason: it blocks **Node's** main thread, in the Electron **main
process**, where `[[CanBlock]]` is true. There is no equivalent anywhere in Tauri. The bridge cannot
be ported — it can only be deleted, which is exactly what makes the deletion clean.

`src/duckdb.ts` + `src/duckdbWorker.ts` is **534 lines of code under 420 lines of comment**, and
every one of them exists to manufacture a synchronous call out of an async-only binding in a
single-threaded host. In Rust, `conn.query(...)` returns. There is no worker, no `SharedArrayBuffer`,
no growable buffer, no control block, no dual reply channel, no spurious-wakeup loop, no
sync/async interleaving analysis, no `Napi::Error` terminate hazard, no 80-line header explaining
why the whole thing does not deadlock.

Invariants 1, 2, 8 and 9 from §1.6 stop being invariants and become *nothing at all* — not
satisfied, not applicable. `mosaic:query`, which today must be async-only or it freezes the app at
animation-frame rate, becomes a plain function call on a worker thread with no special discipline.
Doc 04 §1.5's Channel recommendation for it stands and gets easier.

**Two honest qualifications.**

First, this is a **deletion of accidental complexity, not of essential complexity**, and the
essential part is 2,087 of the 2,621 lines. The SQL in `residentQuery`, `statsResident`,
`anomaliesResident`, `datasetPage`, `datasetView`, `sqlGen` and `parquetStore` is unchanged by the
host language — every rule in the resident layer (cast on the declared type; carry
`file_row_number` and end every `ORDER BY` with it; spell the whitespace class out because
DuckDB's `trim()` and RE2's `\s` disagree; prefer `CASE WHEN` over per-column `FILTER`; wrap every
aggregate in `CAST(… AS DOUBLE)`) is a statement about DuckDB, not about Node. Those survive
verbatim, and so does every subtlety around them: population vs sample standard deviation,
`quantile_cont` vs the `quantile_disc` alias, `mostCommon` tie-breaking by first occurrence, the
two-different-null-conventions problem in `statsResident`'s interface.

Second, **doc 04 already says the important half of this: it does not require Tauri.** §2.4 lists
"deleting the `SharedArrayBuffer` bridge" as a genuine Tauri strength and immediately adds "This is
the big one, and it does not require Tauri." §4 prices the version that does not.

### 3.3 What does not vanish

| Survives the rewrite | Why |
|---|---|
| All 2,087 lines of SQL generation and adaptation | The SQL is about DuckDB, not about Node (§3.2) |
| The BigInt problem — **partly** | Inside Rust it genuinely goes away: `Value::HugeInt(i128)`, `UHugeInt(u128)` and a real `Decimal` are native, so the "every aggregate is `CAST(… AS DOUBLE)`" rule stops being load-bearing *in the engine layer*. It reappears unchanged at the **Rust→webview** boundary, because Tauri's `invoke` is a JSON-RPC-like protocol and JSON has the same 2^53 problem `postMessage` has. Net: the problem moves one layer out and gets a better type system in front of it [RESEARCHED for the types; REASONED for the net effect] |
| Invariants 3–7, 10, 11 | Application properties, not runtime properties (§1.6) |
| The `null` vs `''` distinction | `transforms.isEmptyCell` depends on it; it has to be reasserted in Rust's type system, which has no `''`-is-not-`null` ambiguity but also no `Cell` union |
| The engine hardening and its ordering trap | §2.2. `lock_configuration` behaves the same from any host |
| The cost-model thresholds | `RESIDENT_MIN_ROWS = 1_000`, `ANOMALY_MIN_ROWS = 5_000` + a width term, `DUCKDB_MIN_ROWS = 50_000`. All were derived from measurements of *the JS alternative*, which is the thing being deleted (§7.4) |
| Every fallback path | …unless the JS originals go too, which is §7 |

And one thing that gets **worse**: `formula.ts` — 875 lines of hand-written tokenizer,
recursive-descent parser and tree-walker with no `eval` — has **no SQL twin at all**. `sqlGen`
returns `sql: null` for `calculated_field` and hands the whole pipeline back to the JS fold. A Rust
port must either re-transcribe all 875 lines, or keep a JS engine in the process to run them, or
finally write the formula→SQL compiler that six phases deliberately did not. [MEASURED for the LOC
and the `sql: null`; REASONED for the consequence.]

### 3.4 The lines genuinely at stake

Stated three ways, because the honest answer depends on what you count.

| Scope | physical | **code** |
|---|---:|---:|
| **Deleted outright** — the bridge and its worker | 1,033 | **534** |
| **Must be re-expressed in Rust** — the rest of the DuckDB layer | 4,467 | **2,087** |
| **DuckDB layer, total** | 5,500 | **2,621** |
| **+ the JS reference implementations, if they move too** | 2,609 | **2,054** |
| **+ their differential test suites** (14 files) | 6,736 | **4,986** |
| **Everything the engine question touches** | **14,845** | **9,661** |
| *(for scale: all of `src/`, 63 files)* | *19,388* | — |

**The number to quote is 2,621 lines of code for the engine layer, of which only 534 is the bridge
that Rust makes disappear.** The 2,087-line remainder is a transcription, not a redesign — but a
transcription of code whose *comments* (2,404 lines, most of them recording a measurement that
justifies a specific SQL construct) do not transcribe themselves, and whose correctness is currently
established by the tests in §7 rather than by review.

---

## 4. Option (b) — the Node sidecar

### 4.1 What it is, and what it is not

Two different sidecars are already on the record in this phase and they must not be conflated:

- **Doc 03 §2.0 strategy C — a Node sidecar for the *export* stack. Rejected outright.** "~40–100 MB
  of runtime added to fix a problem that does not exist (A already works), a second process to
  sandbox and sign, and a `spawn` of a bundled interpreter in an app whose security section says the
  shell-free `execFile` rule exists so 'no user/AI/config string ever becomes a command'."
- **Doc 04 §7.2 item 4 — a Rust or N-API sidecar for *DuckDB*, endorsed.** "The one genuine
  architectural win in Phase 6 … a real project, but bounded, testable, and revertible." No cost
  attached.

This section costs the second one. It comes in two shapes, and the distinction is the whole point:

**(b1) The DuckDB sidecar** — a small child process that owns the DuckDB connection and speaks
newline-delimited JSON over stdio. Everything else stays in the Electron main process, in
TypeScript. `src/duckdb.ts` becomes a client of a pipe instead of a client of a worker. *This is not
a Tauri proposal at all* — it is an Electron refactor that happens to be the only part of Phase 6
worth doing.

**(b2) The whole-main-process sidecar** — Tauri becomes a thin shell and the entire existing Node
main process runs behind it, unchanged. This is the shape the brief implies when it says "Tauri
becomes a thin shell", and it is the one that has to carry a bundled Node runtime.

### 4.2 IPC cost, measured

Purpose-built benchmark, this machine, this pass: a `node` child reading newline-delimited JSON
requests on stdin and writing a JSON result on stdout; medians of 21 round trips; parent measures
wall time from write to reply, and separately with `JSON.parse` of the reply included. The
`SharedArrayBuffer` row is the memcpy + `Buffer.toString('utf8')` the current sync path does
instead of a pipe write — the like-for-like comparison, since both paths then pay the same
`JSON.parse`. [MEASURED]

| Result payload | stdio pipe | SAB memcpy + toString | pipe + `JSON.parse` |
|---:|---:|---:|---:|
| 0 B (round-trip floor) | **0.03 ms** | — | 0.03 ms |
| 90,659 B — *a 500-row Explore page* | **0.08 ms** | 0.01 ms | 0.32 ms |
| 906,284 B | 1.07 ms | 0.11 ms | 3.36 ms |
| 9,968,784 B | 83.8 ms | 1.46 ms | 109.6 ms |

Cold start, `spawn` to first reply for a bare `node` child: **19.6 ms** — against the current
worker's ~115 ms handshake.

**Read this against what the resident layer actually returns.** The entire architecture of phases
2–3a exists to make answers small: one scalar for a metric, one row per group for a chart, one
500-row window for the grid. The only large payload in the system is `parquetStore.readTable`
hydrating a whole table — which is the *fallback* path the resident layer exists to avoid.

| Real call | Payload | Transport tax vs today |
|---|---|---|
| `dashboard:metric` | one scalar, <1 KB | **−0.47 ms** (0.03 ms pipe against the ~0.5 ms SAB handshake — the sidecar is *faster*) |
| `visual:data`, aggregated | tens of groups, a few KB | ≈ −0.45 ms |
| `dataset:page` | ~90 KB | **+0.07 ms** |
| `mosaic:query`, per brush frame | KB-scale | below the noise floor |
| `parquetStore.readTable`, 1M rows | ~10 MB+ | +82 ms — real, and on a path the resident layer is designed not to take |

> **The transport cost of moving DuckDB out of process is, for every call the resident layer was
> built to serve, at or below the measurement noise — and for the most common call it is a net
> improvement, because a pipe round trip is cheaper than the SharedArrayBuffer handshake it
> replaces.**

Two caveats stated rather than buried. The benchmark measures a JSON echo, not a DuckDB query, so it
prices the *transport* only; the engine's own time is identical either way. And it uses
newline-delimited JSON, which is what the current wire format already is — a length-prefixed frame
would avoid the scan for `\n` and would matter only in the 10 MB row, where the honest answer is
"don't send 10 MB".

### 4.3 The hop that is *not* the sidecar — and it is the expensive one

Under **(b1)** the stdio hop replaces a worker hop and everything else is unchanged: the renderer
still reaches main over Electron's `ipcRenderer.invoke`, exactly as today.

Under **(b2)** — or under any full Tauri port — a query result crosses **two** boundaries: the
sidecar pipe *and* the webview↔Rust bridge. That second one is not free, and it is worth being
precise because doc 04 §1.5 reads it optimistically ("`dataset:page` … the JSON round-trip is the
same as today's structured clone, probably cheaper").

Tauri's own docs are explicit that commands use "a **JSON-RPC like protocol** under the hood to
serialize requests and responses" and that "all arguments and return data must be serializable to
JSON". The only published numbers I could find are third-party
([`tauri-conduit/BENCHMARKS.md`](https://github.com/userFRM/tauri-conduit/blob/master/BENCHMARKS.md),
Linux i7-10700KF, and it benchmarks Tauri against its own alternative rather than against Electron):

| payload | Tauri JSON `invoke`, Rust dispatch only | end-to-end JS↔Rust, macOS |
|---:|---:|---:|
| 25 B | 722 ns | ~300 µs |
| ~1 KB | 8.1 µs | ~400 µs |
| 64 KB | **2.27 ms** | **6.7 ms** |

with the author's own load-bearing caveat: "for small payloads, the WebView bridge overhead
(~1–5 ms) dominates." [RESEARCHED — third-party, single-machine, and it is the *only* such data I
could find; **no credible Tauri-vs-Electron IPC benchmark exists.** Treat the shape as indicative
and the absolute numbers as unverified.]

Set against this app's measured query times — metric **2 ms**, chart **12 ms**, page **11 ms** at
1M rows — the shape is unwelcome:

- a **~300 µs–1 ms floor** on every `invoke`, regardless of payload, against a metric query that
  takes 2 ms;
- **~6.7 ms end-to-end for 64 KB of JSON**, against a `dataset:page` payload measured here at
  **90,659 B** and a query that takes 11 ms. **The IPC would be the same order of magnitude as the
  work.**

There is an escape hatch and it should be named: `tauri::ipc::InvokeResponseBody` has a
**`Raw(Vec<u8>)`** variant, `Response::new` accepts it, and `Channel<T>` defaults to carrying it —
so a binary path exists and the same benchmark puts 64 KB at **600 µs** through it, an 11× win. But
Tauri ships the pipe and **no codec**: no framing, no sequencing, no matching JS decoder. Taking
that path means hand-rolling a wire format and a decoder — which is to say, **rebuilding
`encodeText`/`decodeRows` from `duckdbWorker.ts`/`duckdb.ts` on the other side of a different
boundary.** Doc 04 §1.5's Channel recommendation for `mosaic:query` is right, and this is the reason
it is not optional.

> The comparison that matters: the sidecar hop this section prices costs **0.08 ms** for a real
> Explore page. The webview hop a Tauri port *adds on top* plausibly costs **6.7 ms** for the same
> page unless someone writes a binary codec. **The cheap boundary is the one Phase 6 would add; the
> expensive one is the one it would keep.**

### 4.4 Binary size, startup, signing

**(b1), the DuckDB sidecar: no new binary at all.** Electron already ships a Node runtime; the
sidecar is `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, or a `utilityProcess`, or a plain
`child_process.fork`. **Added bytes: zero.** [REASONED — the mechanism is standard Electron; not
built here.] The `libduckdb.dylib` moves from the main process's address space to the child's; the
peak RSS of the *pair* is unchanged, but DuckDB's buffer pool becomes independently killable, which
is a real robustness gain the current design cannot offer (a wedged worker today can only be
orphaned, never terminated — §1.2).

**(b2), the whole-main-process sidecar under Tauri: a bundled Node runtime.** Doc 03 §2.0 already
puts this at ~40–100 MB and rejects it for the export stack. For the engine the arithmetic is worse,
not better, because you would be paying it *on top of* the DuckDB that has to ship regardless:

| | MiB |
|---|---:|
| Tauri shell + WebKit (system) | ~10–15 (RESEARCHED, doc 04 §5.2) |
| DuckDB, arm64, stripped | ~46 (MEASURED, §2.3) |
| Bundled Node runtime for the sidecar | **~46–50 for the bare `node` binary alone** on macOS arm64, +1–10 for the app; Node SEA adds ~5; `bun --compile` is ~57 for hello-world (RESEARCHED; consistent with doc 03 §2.0's 40–100) |
| The asar's ~40 MiB of browser JS, unchanged | ~40 |
| **Total** | **~142–151, before any of it is a universal build** |

against doc 04 §5.2's "full Tauri port: ~125–165 MB installed" — which assumed no Node runtime. **A
Tauri shell over a Node sidecar is not obviously smaller than the correctly-packaged Electron build
doc 04 §7.2 items 1–2 produce for a day's work (~434 MB → and with the `lipo` fix from §2.3,
~377 MB).** [REASONED; the ranges compound, so treat this as "the win is not clearly there", not as
a precise figure.]

**Signing — and there is an open Tauri blocker here.** On macOS a bundled interpreter inside a
hardened-runtime app needs its own signature, and executing it needs an entitlement. The repo
already carries `hardenedRuntime: true` and a `build/entitlements.mac.plist`, and already ships one
hand-built helper binary (`disclaim-exec`, compiled in `scripts/afterPack.ts` and re-signed in
`afterSign.ts`), so the Electron-side machinery exists.

The Tauri side does not, yet. **[tauri-apps/tauri#11992](https://github.com/tauri-apps/tauri/issues/11992)
— "adding `externalBin` breaks macOS notarization" — has been open since 2024-12-17, is still
labelled `status: needs triage`, has no assignee, no maintainer response and no linked PR.**
Notarization returns *Invalid, error code 4000: "The signature of the binary is invalid"* — on the
**main app binary**; removing `externalBin` makes the identical app notarize fine. [RESEARCHED,
verified live this pass.] Tauri also does not build universal sidecars for you: `externalBin`
requires one binary per `-<target-triple>` and only the Rust binary gets `lipo`'d.

Layered on top: Tauri's sidecar permissions require declaring `shell:allow-execute` with the
**allowed arguments enumerated in the capability**. That is genuinely stricter than what the app has
today and is a point in Tauri's favour — but it is stricter *about spawning a general-purpose
interpreter you shipped yourself*, inside an app whose security section forbids `shell: true` so
that "no user/AI/config string ever becomes a command". That is the tension doc 03 §2.0 named, and
#11992 says the mechanism does not currently ship past notarization anyway.

**This applies to (b2) and to any Tauri sidecar. It does not apply to (b1)**, which spawns
`process.execPath` — a binary Electron already signs.

### 4.5 What the sidecar does not buy

It does not buy memory safety in the parser (DuckDB is C++ either way). It does not buy Arrow
(that is a property of the binding, and an N-API sidecar keeps `@duckdb/node-api`; a *Rust* sidecar
would get `query_arrow`, at the cost of writing the resident layer in Rust, which is §3). It does not
buy the BOM fix unless it is a Rust sidecar. It does not reduce the download.

What it buys is precisely one thing: **invariant 1 stops being a problem.** The main process gets a
`Promise`-based DuckDB client with no `Atomics.wait` anywhere, 534 lines get deleted, and the
callers that currently *require* a synchronous answer either get `await`ed — most of them are
already inside `async` IPC handlers — or keep a thin blocking shim over the pipe that is still
simpler than the SAB machinery. That is the same prize §3.2 identifies, at a fraction of the cost,
with the differential test suite of §7 fully intact because **nothing moves out of TypeScript.**

---

## 5. Option (c) — don't do Phase 6

The null option, stated at engine level so it can be compared like for like.

**What is preserved:** 3,285 assertions that run under plain `node` on `ubuntu-latest` in ~90 s of
CI, with no Electron, no Rust toolchain, and no simulator [MEASURED — `.github/workflows/ci.yml`
`node-version: '24'`, `runs-on: ubuntu-latest`; suite runs green at `610e4b5`]. The differential
discipline in full. Six phases of measurements that are still checkable against the code they
describe. `formula.ts` continues to have exactly one implementation. The engine hardening of §2.2
continues to be enforced by a test that runs on every PR.

**What is paid for it:** the 534-line bridge stays, with its `Atomics.wait`, its terminate hazard,
its two reply channels and its BOM workaround. `@duckdb/node-api` remains a single point of
dependency risk. No Arrow. The bridge is the most intricate code in the repository and the least
likely to be safely modified by anyone who has not read all 420 lines of its comments.

**What is left on the table, and recoverable without any of this:** ~169 MiB of dead DuckDB in the
arm64 install (§2.3), which is a `--mac --arm64` target and a `lipo -thin` call in a hook that
already exists.

---

## 6. Per-module port table

Verdicts: **stays JS** = no reason to move it, and moving it costs a reference implementation.
**must become Rust** = has no meaning outside the engine and would follow it. **no Rust equivalent**
= there is no drop-in, and the replacement is a rewrite with its own correctness burden.

### 6.1 The DuckDB layer

| Module | code | Verdict under (a) Rust | Under (b1) sidecar | Note |
|---|---:|---|---|---|
| `src/duckdb.ts` | 364 | **deleted** | rewritten as a ~100-line pipe client | The prize (§3.2) |
| `src/duckdbWorker.ts` | 170 | **deleted** | becomes the sidecar's main | |
| `src/parquetStore.ts` | 172 | **must become Rust** | stays JS | `bomSafe` is deleted under (a) — and must be replaced by a test proving the BOM survives |
| `src/sqlGen.ts` | 299 | **must become Rust** | stays JS | Pure string builder; imports no binding; testable today by a plain node self-check (139 assertions) |
| `src/pipelineDuck.ts` | 86 | **must become Rust** | stays JS | Off by default. Would ship dark in Rust too |
| `src/residentQuery.ts` | 234 | **must become Rust** | stays JS | |
| `src/statsResident.ts` | 252 | **must become Rust** | stays JS | |
| `src/anomaliesResident.ts` | 405 | **must become Rust** | stays JS | The `detail` strings are quoted verbatim into a model prompt — byte-identical output is a hard requirement |
| `src/datasetPage.ts` | 286 | **must become Rust** *except* `pageRowsJs` | stays JS | `pageRowsJs` is both the test oracle **and** the v2-record fallback. It cannot be deleted; it would have to be duplicated |
| `src/datasetView.ts` | 90 | **must become Rust** | stays JS | |
| `src/ipc/mosaic.ts` | 263 | **must become Rust** | stays JS | Includes the hardening (§2.2) and `isSingleStatement`, a hand-written DuckDB lexer verified construct-by-construct against this build |
| `src/transforms.ts` | 553 | **stays JS** — or the fold has no reference | stays JS | |
| `src/formula.ts` | 875 | **no Rust equivalent** | stays JS | No SQL twin exists. `sqlGen` returns `sql: null` and defers to the fold (§3.3) |
| `src/metricValue.ts` | 48 | **stays JS** (reference) | stays JS | |
| `src/vizData.ts` | 190 | **stays JS** (reference) | stays JS | |
| `src/datasetStats.ts` | 120 | **stays JS** (reference) | stays JS | |
| `src/anomalies.ts` | 268 | **stays JS** (reference) | stays JS | Pure detector; the model only narrates its output |

The "stays JS (reference)" rows are the crux. Under (a) they have no runtime home — the process they
run in no longer exists. Keeping them means keeping a JS engine purely as a test oracle; dropping
them means §7.

### 6.2 `pg`, `exceljs`, `simple-icons`

| Dependency | On disk | Used by | Verdict |
|---|---:|---|---|
| **`pg`** | 140 KB | `src/connectionRun.ts` (151 code lines) + `src/connections.ts` (250) | **No Rust equivalent that is a drop-in.** `tokio-postgres` exists and is mature, but the port is not "swap the client": the read-only guarantee, the parameterised `information_schema` queries, the sub-select wrap with `ROW_LIMIT = 1_000_000`, the `statement_timeout`, and the always-close-in-`finally` are the security contract and must be reimplemented, not inherited (doc 04 §6.4 says the same). **Brief §6.5's DuckDB-`postgres`-extension route is blocked twice over:** by the engine hardening (§2.2), and by [duckdb-rs#483](https://github.com/duckdb/duckdb-rs/issues/483) — `ATTACH` of a Postgres database **segfaulted (SIGSEGV) from duckdb-rs** while the identical SQL worked in the DuckDB CLI, **closed as `not_planned`, no fix and no workaround** [RESEARCHED]. Treat "ATTACH Postgres from Rust" as unproven. 140 KB is not a size argument for any of this. |
| **`exceljs`** | 23 MB in `node_modules`, **6.2 MiB in the asar** (doc 04 §5.2) | `src/parseXlsx.ts` — **46 code lines**, read-only, single sheet, `workbook.xlsx.readFile` + cell iteration only | **The only genuine size prize in this table**, and the only one where a DuckDB extension would do real work. But the `excel` extension is a `LOAD`, so §2.2 applies. `calamine` (Rust) is the honest alternative and is a small, well-scoped crate — but read-only XLSX is 46 lines of a 19,388-line main process, and it is a *value-fidelity* problem (`cell.text` renders a lossless display string) more than a parsing one. [MEASURED for the LOC and the asar size; RESEARCHED for `calamine`'s existence; REASONED for the fidelity risk.] |
| **`simple-icons`** | 25 MB in `node_modules`, **15.2 MiB in the asar** (doc 04 §5.2) | `src/icons.ts` — **47 code lines**. Reads **6 export names** by a hard-coded `providerId → siXxx` map, extracts `{path, color, title}`, ships them to the renderer | **Not a compute-engine question at all, and not a Tauri question.** The app uses six SVG paths out of a 15 MiB package. Doc 04 §7.2 item 2 already says: generate the map at build time, move `simple-icons` to a devDependency, recover ~15 MiB. That is true today, under Electron, and has nothing to do with the shell. `npm run icons:verify` already exists to keep the map honest against the installed version. |

The pattern across all three: **the dependency-elimination case in brief §6.5 is a size argument,
and the sizes do not support it.** `pg` is 140 KB. `exceljs` is 6.2 MiB against `simple-icons`'
15.2 MiB, which needs no Rust at all. And the one DuckDB-extension route that would subsume both is
blocked by the app's own security hardening.

---

## 7. The test-suite consequence

This is the decisive argument, and it deserves a real number rather than an adjective.

### 7.1 What the discipline actually is

The repository's house style for anything with two implementations: run the **same** input through
both and compare with `Object.is`, rather than against hand-written expected values. From
`scripts/test-residentQuery.ts`:

> "a fixture is written with `parquetStore.writeTable`, read back with `parquetStore.readTable`, and
> the resident answer is compared to `metricValue.computeMetric` / `vizData.buildVizData` over those
> exact rows. **A hand-written expectation can agree with a bug in both implementations; an
> equivalence assertion cannot.**"

`Object.is` specifically, so `''` can never pass as `null` and `-0` never as `0`. There are 42
`Object.is` comparison sites across the differential suites, most of them inside loops over fixture
matrices. Several suites additionally **spy on `datasets.getDataset`** to assert the table was never
hydrated — so a fast path that silently stops firing fails loudly instead of passing green and
inert. `scripts/test-mosaicIpc.ts` goes further and replaces `duckdb.query`/`exec` with *throwing
stubs*, proving the Mosaic surface never touches the sync bridge.

This is the discipline that made six phases safe. It is worth being precise about what it costs to
lose.

### 7.2 The measurement

Run 1: `npm test` at `610e4b5`. **3,285 assertions, 0 failures, exit 0.**

Run 2: `node_modules/@duckdb/node-api` moved aside so the binding cannot load, every one of the 43
suites re-run individually, then restored. This is not a hypothetical — it is exactly the
"`isAvailable()` returns false, use the JS path" state the bridge is designed to degrade into.
**1,637 assertions ran and passed; 17 failed; 1,648 assertions did not execute at all.**

| | assertions | share |
|---|---:|---:|
| Total, engine present | **3,285** | 100% |
| Still executing with no DuckDB | 1,637 | 49.8% |
| **Require a live DuckDB engine** | **1,648** | **50.2%** |

Per suite, full run → no-engine run: [MEASURED]

| suite | with | without | **lost** | what it asserts |
|---|---:|---:|---:|---|
| `test-residentQuery` | 356 | 0 | **356** | differential vs `metricValue` + `vizData` |
| `test-metricRewire` | 335 | 334 | 1 | differential **through the shipped IPC handler**; degrades gracefully and re-runs against the JS path, so its resident branch silently stops being tested |
| `test-datasetPage` | 193 | 0 | **193** | differential vs `pageRowsJs`; permutation-exactness across pages |
| `test-anomaliesResident` | 190 | 1 | **189** | differential vs `anomalies.detectAnomalies`, incl. verbatim `detail` strings |
| `test-statsResident` | 168 | 1 | **167** | differential vs `datasetStats`, incl. **key sets**, not just values |
| `test-vizRewire` | 163 | 1 | **162** | end-to-end chart data through the handler |
| `test-mosaicIpc` | 122 | 0 | **122** | the hardening (§2.2) + `isSingleStatement` + the async-only rule |
| `test-duckdb` | 113 | 1 | **112** | the bridge itself: interleaving, timeouts, overflow, the BOM bug |
| `test-pipelineDuck` | 113 | 3 | **110** | differential vs `transforms.applyPipeline` |
| `test-datasetView` | 101 | 0 | **101** | typed view; `null` vs `''` survival |
| `test-parquetStore` | 84 | 0 | **84** | storage round-trip fidelity |
| `test-wideTables` | 29 | 7 | **22** | the 1,000-column regression (`CASE WHEN` vs `FILTER`) |
| `test-datasetDistinct` | 22 | 0 | **22** | differential vs `distinctValuesJs` |
| `test-datasetsMigration` | 42 | 35 | **7** | v2 inline-rows → v3 Parquet |
| `test-sqlGen` | 139 | 139 | 0 | pure string builder — survives, because it executes nothing |
| `test-plotSpec` | 85 | 85 | 0 | Mosaic spec builder — pure |
| `test-datasets` | 78 | 78 | 0 | degrades to the v2 path cleanly |
| all other 26 suites | 1,152 | 1,152 | 0 | pure logic |
| **total** | **3,285** | **1,637** | **1,648** | |

### 7.3 What happens to those 1,648 if the JS original moves to Rust

Three distinct fates, and only one of them is "port the test".

**Fate 1 — the ~1,100 differential assertions lose their oracle.** `test-residentQuery` (356),
`test-datasetPage` (193), `test-anomaliesResident` (189), `test-statsResident` (167),
`test-datasetDistinct` (22), plus the resident branch of `test-metricRewire` (335 assertions that
run either way but only *mean* something when both paths exist) and `test-vizRewire` (162). These do
not assert values. They assert **agreement**. Delete `metricValue.ts`, `vizData.ts`,
`datasetStats.ts`, `anomalies.ts` and `pageRowsJs` and there is nothing left to agree with — the
tests do not "get ported to Rust", they **become a different and weaker kind of test**: hand-written
expected values, which is precisely what the house style exists to avoid, and which the residentQuery
suite's own header says can "agree with a bug in both implementations".

The alternative is to keep the JS originals *purely as test oracles*, which means keeping a Node
runtime in the test harness of an app that no longer has one — a second implementation maintained by
nobody, drifting, and exercised only in CI. Doc 03 §4.2 proposes exactly this pattern for
`sanitizeBundle` and it is the right instinct; at the scale of the whole resident layer it is a
2,054-line shadow codebase.

**Fate 2 — the ~430 engine-behaviour assertions port, but only after the thing they test is
rebuilt.** `test-duckdb` (112) tests the bridge that no longer exists; most of it is deleted, and
what replaces it is a much smaller suite because there is much less to get wrong (that is the win).
`test-mosaicIpc` (122) and `test-parquetStore` (84) and `test-datasetView` (101) test SQL behaviour
against the real engine and would port to `cargo test` more or less as-is.

**Fate 3 — 110 assertions test a path that would not be rebuilt.** `test-pipelineDuck` covers a
compute swap that is off by default and, on the numbers in its own header (load 1,914 ms vs GROUP BY
4 ms at 100k), a 100–500× regression whenever the data is not already resident. A Rust port would
probably not carry it, which means dropping the only differential proof that `sqlGen`'s CTE chain
matches `transforms.applyPipeline` — and `sqlGen` (139 assertions, all surviving) only checks the
*string*, not the *result*.

**And a fourth thing, which is not an assertion count.** The suite runs today in CI on
`ubuntu-latest` with `node-version: 24`, no Electron, no display, no toolchain beyond `npm ci`.
Doc 04 §6.3 already flags that a Tauri CI would test WebKitGTK while users run WKWebView. The engine
half is worse in a quieter way, and it is not speculation: **the `duckdb` crate's `parquet` feature
implies `bundled`**, so `cargo test` for anything touching Parquet has to **compile DuckDB from
source** on every cold cache. Reported: **~3–4 minutes on an M1, >15 minutes / effectively hung on a
2019 Intel MacBook Pro** (duckdb-rs issue #180), with `libduckdb-sys` previously measured at ~60% of
total project build time (issue #70). That turns a ~90-second check into a multi-minute one at best,
and CI latency is the thing that decides whether a discipline survives contact with a deadline.
[MEASURED for the current CI shape; RESEARCHED for the feature implication and the reported compile
times; nothing was compiled here.]

### 7.4 The honest counter-argument

It should be made, because "we would lose tests" is a bad argument on its own — tests are a means.

1. **A differential test is a *transitional* device by design.** It exists to make a swap safe. Once
   the resident path is the only path, the JS original is dead code kept alive by its own test suite.
   There is a real argument that phases 1–3a's differential harness has already done its job and
   that continuing to carry 2,054 lines of reference implementation is the sunk-cost position.

   **Rebuttal, and it is decisive here: the JS originals are not dead code. They are the shipped
   fallback.** Every resident entry point returns `null` on any failure and the caller *runs the JS
   path* (§1.4). That is not a test scaffold, it is the product's behaviour on a machine where the
   native module fails to load — which the repo cares about enough to have made v2→v3 migration
   conditional on it. The differential tests are not testing a migration; they are testing that two
   *shipped* paths agree.

2. **`Object.is`-equality is not the only way to be sure.** Property-based testing, or golden files
   generated once from the JS implementation and then frozen, would keep most of the value.

   **Rebuttal: golden files are hand-written expectations with extra steps** — they freeze whatever
   the JS did on the day they were generated, including its bugs, and they cannot cover the fixture
   *matrices* these suites actually run (`test-anomaliesResident` alone is 611 code lines driving
   the same comparison over many shapes). Property tests would genuinely help, and are worth having
   regardless; they are not a substitute for "these two produce the same bytes".

3. **The thresholds argument cuts against the JS path too.** `RESIDENT_MIN_ROWS = 1_000` and friends
   were derived by measuring the JS alternative. If the JS alternative is gone, the thresholds are
   meaningless and can be deleted — a simplification.

   **Rebuttal: they can be deleted only because the choice they encode disappears, and that choice
   was measured to matter** — `src/ipc/dashboards.ts:53-87` records eight row-counts of head-to-head
   timings to place one constant. Deleting the alternative does not make the fast path faster; it
   removes the ability to ever check that it is.

### 7.5 The cost of rebuilding the discipline in Rust

Not "port 1,648 assertions". The work is:

| | |
|---|---|
| Re-express 4,986 lines of test code (14 suites) in Rust | mechanical but large |
| Decide, per suite, what replaces the oracle | the actual design problem — and for the ~1,100 differential assertions there is no good answer that does not keep JS alive |
| Re-derive every threshold, or delete it | §7.4 item 3 |
| Accept a CI that compiles DuckDB | §7.3 |
| Re-establish the "prove it never hydrated" spies | these currently work by monkey-patching a module export; the Rust equivalent is a trait + a fake, i.e. a design change to production code |

Against which option (b1) costs: **zero.** Nothing moves out of TypeScript, so all 3,285 assertions
keep running, unchanged, on `ubuntu-latest`, in 90 seconds — and the 534-line bridge still goes away.

> **That asymmetry is the argument.** The only part of Phase 6 with a clear payoff on the compute
> axis is available without paying any of the test-suite cost.

---

## 8. Verdict

### 8.1 Recommendation: **agree with doc 04 — close Phase 6.** Then do (b1).

Doc 04 reached "close" from the process model, the security scorecard and the size arithmetic. The
engine reaches the same place by a different road, and the road matters because the engine is where
the brief expected the win to be.

**Five findings, on the engine's own evidence:**

1. **The engine contributes nothing to the size case.** DuckDB is ~46–55 MiB of native code per
   architecture under either shell (§2.3, MEASURED). Meanwhile the arm64 install today carries
   **168.6 MiB of dead DuckDB** — two fat dylibs where one thin slice is needed — recoverable with a
   `--mac --arm64` target and a `lipo -thin` call in an `afterPack` hook that already exists. **The
   largest single size win available anywhere in this product is on the compute axis, and it is a
   packaging fix, not a rewrite.**

2. **The one genuine architectural win does not need Tauri, and now has a price.** Deleting the
   `Atomics.wait`/`SharedArrayBuffer` bridge removes 534 lines of the most delicate code in the
   repository. Doc 04 §5.3 said so and said it was free of Tauri; §4.2 now shows the sidecar that
   delivers it costs **+0.07 ms on a 500-row Explore page and −0.47 ms on a metric card** — i.e. it
   is faster on the most common call than the handshake it replaces — and **zero added bytes**,
   because Electron already ships the runtime.

3. **Brief §6.5 is blocked three times over.** DuckDB's `postgres` and `excel` extensions are
   `LOAD`s; the shipped hardening makes `LOAD` a permission error irreversibly and process-wide
   (§2.2, MEASURED); autoload fetches them from `extensions.duckdb.org`, which is doc 04 §5.4's
   invariant-9 violation (RESEARCHED, confirmed); and `ATTACH` of a Postgres database **segfaults
   from duckdb-rs**, filed and closed `not_planned` (§6.2, RESEARCHED). Replacing `pg` (140 KB) and
   `exceljs` (6.2 MiB in the asar) would mean unwinding a control that a test currently enforces on
   every PR — to recover less than half of what moving `simple-icons` to a devDependency recovers
   with no Rust at all.

4. **The boundary Phase 6 would add is cheap; the one it would keep is not.** A stdio sidecar hop
   costs **0.08 ms** on a real 500-row Explore page (MEASURED). The webview↔Rust hop a Tauri port
   sits on top of costs a **~300 µs–1 ms floor per `invoke`** and plausibly **~6.7 ms for 64 KB of
   JSON** (RESEARCHED, third-party and unverified) — against queries measured at 2–12 ms. Getting
   that back means hand-writing a binary codec over `ipc::Channel`, i.e. rebuilding
   `encodeText`/`decodeRows` on a different boundary (§4.3).

5. **Half the test suite is the engine's.** **1,648 of 3,285 assertions (50.2%) do not execute
   without a live DuckDB engine** (MEASURED). Roughly 1,100 of them are *differential* — they assert
   that the resident SQL path and a pure-JS original produce identical bytes. A Rust port does not
   port them; it deletes their oracle, because the JS originals are not test scaffolding, they are
   **the shipped fallback** that runs whenever the native module fails to load. What replaces them
   is hand-written expected values — "which can agree with a bug in both implementations", in the
   suite's own words. And the CI that runs them in ~90 s on `ubuntu-latest` would become one that
   compiles DuckDB from source: **3–4 minutes on an M1, >15 minutes on a 2019 Intel**, because the
   crate's `parquet` feature implies `bundled` (§3.1, RESEARCHED).

### 8.2 What would change this verdict

Falsifiable, in doc 04 §7.3's style. Any **one** of these reopens the engine question:

1. **A Rust `duckdb` static link measured under 25 MiB per architecture.** That would be roughly
   half the measured stripped dylib and would mean DCE reaches much further into DuckDB than §2.3
   assumes — enough that the engine would start contributing to the size case instead of being
   neutral. *Cost to check: install Rust, one `cargo build --release --features bundled,parquet`,
   one `ls -l`; budget 3–4 minutes of compile on Apple Silicon.* Note the prior is against it: the
   official `duckdb_cli-osx-arm64` — an entire statically linked DuckDB CLI — is 17.0 MB
   **compressed**, and this pass measured the stripped arm64 dylib at 15.8 MB compressed. A 25 MiB
   uncompressed static link would have to beat both by a wide margin.

2. **`@duckdb/node-api` stops being maintained** (doc 04 §7.3 says this too). It is at `1.5.5-r.3`
   tracking DuckDB v1.5.5, with healthy download counts, so this is not today's problem — but it is
   a single-vendor dependency for the entire compute layer, and (b1) is the hedge that makes it
   survivable: a sidecar's client protocol does not care what language the sidecar is written in, so
   a Node sidecar can be replaced by a **Rust** sidecar later **without touching a single caller**.
   Worth noting for the comparison: `duckdb-rs` releases the **same day** as upstream DuckDB and has
   done for the last five releases (§3.1) — it is the better-maintained of the two bindings, and
   that is an argument for the sidecar's swap point, not for the shell.

3. **The BOM bug turns out to be unfixable upstream.** Doc 04 §7.3 pairs this with the Arrow gap.
   §1.5 found it has **never been reported** — so "upstream won't fix it" is currently an
   assumption, not a finding. *Cost to check: file one issue.* If it is declined or ignored for a
   year, that is real evidence; today there is none.

4. **Arrow becomes load-bearing.** Today the wire format is columnar JSON and it is fast enough
   because answers are small — the entire resident layer is designed so that nothing large crosses.
   If a feature genuinely needs to move millions of rows to the renderer (Mosaic's `consolidate:true`
   path being the obvious candidate, currently disabled), the JSON wire becomes the bottleneck and
   `query_arrow` becomes the answer. That is a **Rust sidecar** argument, not a Tauri argument.

5. **A formula→SQL compiler gets written.** `formula.ts` is 875 lines with no SQL twin and is the
   single largest "no Rust equivalent" in §6.1. If it ever gains one, the prepare pipeline stops
   needing a JS fold at all, and the balance in §7 shifts materially.

6. **Someone builds a real Tauri spike with DuckDB bundled and it lands under 80 MB installed.**
   Doc 04 §7.3's condition, restated here because §2.3 makes it tighter: with ~46 MiB of DuckDB and
   ~40 MiB of unavoidable browser JS in it, an 80 MB build has ~-6 MB of headroom for everything
   else. **On these measurements that target is not reachable**, which is itself worth knowing
   before anyone spends a week finding out.

### 8.3 Do these instead — the engine's additions to doc 04 §7.2

| # | Action | Wins | Cost |
|---|---|---|---|
| E1 | Ship a `--mac --arm64` DMG **and** `lipo -thin arm64` the DuckDB dylib in `afterPack` | **~169 MiB installed** on arm64 — more than doc 04 §7.2 item 1 alone, and more than half of what a full Tauri port claims | one build target + ~5 lines in a hook that already shells out to `clang` |
| E2 | `strip -S -x` the thinned dylib in the same hook | a further ~9 MiB, and re-sign in `afterSign` as the helper already does | ~2 lines; verify the signature survives |
| E3 | **(b1)** Move DuckDB to a stdio sidecar (`utilityProcess` / `ELECTRON_RUN_AS_NODE`) and delete `duckdb.ts`'s SAB machinery | −534 lines of the highest-risk code in the repo; a killable engine process; **faster on the most common call**; a swap point for a future Rust engine | a real project, bounded and revertible; every caller becomes `await`ed or keeps a thin blocking shim. **All 3,285 assertions keep running** |
| E4 | **File the BOM bug upstream** on `duckdb-node-neo` — §1.5 verified it has never been reported | converts doc 04 §7.3's "upstream won't fix it" from an assumption into evidence, either way; there is precedent for BOM fixes landing in core | minutes. The reproduction (`SELECT chr(65279) \|\| 'x'`) is already in `scripts/test-duckdb.ts` |
| E5 | Pin the BOM behaviour of whatever transport replaces the current one | the `bomSafe` inverse is exact only because the strip is exact; a new transport that *doesn't* strip would make `bomSafe` a **corrupter** | one test, and it already exists to copy |
| E6 | Generate the `simple-icons` map at build time (doc 04 §7.2 item 2) | ~15.2 MiB — the app uses **six** icon paths out of a 15 MiB package | `scripts/verify-icons.ts` already exists to keep it honest |

E1 and E2 together take ~178 MiB out of the arm64 install for well under a day's work, with no
architectural risk and no Rust. E3 is the only part of Phase 6 the engine evidence actually supports.

---

## 9. Sources

- **This checkout**, `/Users/ashishb/Projects/ordinate-phase6` @ `610e4b5`. All **MEASURED** figures
  come from it, except the built-artifact paths, which are `/Users/ashishb/Projects/ordinate/dist/`
  (the same build doc 04 §5.1 measured, predating the MapLibre swap).
- **Test-suite figures**: `npm test` (43 suites, 3,285 assertions, exit 0), then the same 43 suites
  re-run individually with `node_modules/@duckdb/node-api` moved aside and afterwards restored.
  Assertions counted as lines matching `^ok  `, which is the suites' own reporter format.
- **Binary figures**: `lipo -info`, `lipo -detailed_info`, `lipo -thin`, `strip -S -x`, `nm -a`,
  `nm -gU`, `size -m`, `gzip -9`, `stat -f%z` on
  `node_modules/@duckdb/node-bindings-darwin-arm64/libduckdb.dylib` and on the two copies inside
  `dist/mac-arm64/Screenchart.app`. Engine version confirmed as `v1.5.5` by `SELECT version()`
  through the binding; `@duckdb/node-api` and `@duckdb/node-bindings` both `1.5.5-r.3`.
- **Sidecar figures**: a purpose-built benchmark written for this pass (a `node` child echoing
  newline-delimited JSON over stdio; medians of 21; parent and child both Node v24.14.0), against a
  `SharedArrayBuffer` `set` + `Buffer.toString('utf8')` baseline of the same byte counts. It prices
  transport only — the engine's own query time is identical either way.
- **MEASURED-IN-REPO** figures are cited inline to the file and line that records them:
  `src/duckdb.ts` (transport comparison, worker startup, memcpy, the BOM reproduction, the
  `Napi::Error` terminate reproduction), `src/ipc/dashboards.ts:40-87` (the handshake cost, the
  eight-row threshold table, the float-summation divergence), `src/ipc/mosaic.ts:73-120` (the
  hardening, measured against this DuckDB build), `src/pipelineDuck.ts:26-50` (load vs query vs
  fold), and the resident-layer table in `CLAUDE.md`.
**RESEARCHED live in this pass** (fetched 2026-08-02):

- [`duckdb` on crates.io](https://crates.io/crates/duckdb) ·
  [API, v1.10505.0](https://crates.io/api/v1/crates/duckdb/1.10505.0) —
  version, publish date, MSRV, download counts, the engine-version encoding scheme.
- [duckdb/duckdb-rs](https://github.com/duckdb/duckdb-rs) and its
  [`crates/duckdb/Cargo.toml`](https://raw.githubusercontent.com/duckdb/duckdb-rs/main/crates/duckdb/Cargo.toml)
  — the feature graph read verbatim: `parquet`/`json` imply `bundled`; no `httpfs` feature; `arrow`
  is a non-optional dependency. [docs.rs/duckdb](https://docs.rs/duckdb/latest/duckdb/) and
  [`types::Value`](https://docs.rs/duckdb/latest/duckdb/types/enum.Value.html) — the rusqlite-shaped
  synchronous API, `query_arrow`, `HugeInt(i128)`/`UHugeInt(u128)`/`Decimal`.
- duckdb-rs issues [#180](https://github.com/duckdb/duckdb-rs/issues/180) (bundled build times),
  [#351](https://github.com/duckdb/duckdb-rs/issues/351) (extension autoload failure),
  [#461](https://github.com/duckdb/duckdb-rs/issues/461) + [PR #732](https://github.com/duckdb/duckdb-rs/pull/732)
  (`bundled-cmake`, static extensions), [#483](https://github.com/duckdb/duckdb-rs/issues/483)
  (**ATTACH Postgres segfault, closed `not_planned`**), and #464 (ICU unbundled over the crates.io
  10 MB limit).
- [DuckDB v1.5.5 release asset manifest](https://api.github.com/repos/duckdb/duckdb/releases/tags/v1.5.5)
  — `static-libs-osx-arm64.zip` 26,256,428 B, `duckdb_cli-osx-arm64.zip` 17,005,846 B, both
  compressed; the cross-check for §2.3. [DuckDB Rust client docs](https://duckdb.org/docs/current/clients/rust.html) ·
  [postgres extension](https://duckdb.org/docs/current/core_extensions/postgres/overview.html) ·
  [installing extensions](https://duckdb.org/docs/current/extensions/installing_extensions.html)
  (autoload hosts, `custom_extension_repository`, `extension_directory`).
- [`@duckdb/node-api` on npm](https://registry.npmjs.org/@duckdb/node-api) — `1.5.5-r.3`, sole
  runtime dep `@duckdb/node-bindings`, no Arrow dependency. [duckdb-node-neo#45](https://github.com/duckdb/duckdb-node-neo/issues/45)
  — Arrow support, open since 2024-11-03, assigned, milestoned, no PR.
  **BOM search: negative result** — GitHub issue search on `duckdb/duckdb-node-neo` for
  `BOM OR FEFF OR "byte order mark"` returns 0; the 4 BOM issues in `duckdb/duckdb`
  (#2908, #16568, PR #1573, PR #3014) are all closed and all about CSV/JSON *readers*.
- [Tauri sidecar](https://v2.tauri.app/develop/sidecar/) ·
  [IPC concept](https://v2.tauri.app/concept/inter-process-communication/) ("JSON-RPC like
  protocol") · [HTTP headers](https://v2.tauri.app/security/http-headers/) (the COOP/COEP
  `SharedArrayBuffer` example) ·
  [tauri-apps/tauri#11992](https://github.com/tauri-apps/tauri/issues/11992) (**`externalBin`
  breaks macOS notarization; open since 2024-12-17, untriaged**) ·
  [tauri-apps discussion #6269](https://github.com/orgs/tauri-apps/discussions/6269) (SAB-for-IPC
  rejected as a category error). Binary IPC:
  [`ipc::Response`](https://docs.rs/tauri/latest/tauri/ipc/struct.Response.html) ·
  [`InvokeResponseBody`](https://docs.rs/tauri/latest/tauri/ipc/enum.InvokeResponseBody.html) ·
  [`ipc::Channel`](https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html).
- [`tauri-conduit/BENCHMARKS.md`](https://github.com/userFRM/tauri-conduit/blob/master/BENCHMARKS.md)
  — the §4.3 IPC table. **Third-party, single machine, Linux, and it benchmarks Tauri against its
  own alternative rather than against Electron.** It is the only such data I could find; no credible
  Tauri-vs-Electron IPC benchmark exists, and claims circulating about "Electron 32→34 shared-memory
  IPC" or "Tauri 2.0 rewrote its IPC layer" could not be traced to a primary source and are **not**
  relied on here.
- [V8 — Atomics.wait/notify/waitAsync](https://v8.dev/features/atomics) ·
  [TC39 `waitAsync` proposal](https://tc39.es/proposal-atomics-wait-async/) ·
  [Chromium issue 41476333](https://issues.chromium.org/issues/41476333) ·
  [`WaitOnMainThread.md`](https://github.com/WebAssembly/shared-everything-threads/blob/main/proposals/shared-everything-threads/WaitOnMainThread.md)
  — `[[CanBlock]] = false` on a document's main thread, and the still-open proposal to change it.
- [Node.js single executable applications](https://nodejs.org/api/single-executable-applications.html)
  (Stability 1.1; `--build-sea` in v25.5.0) and
  [Joyee Cheung, 2026-01-26](https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/)
  (~5 MB added to `node` for built-in SEA generation) — the runtime-size figures in §4.4.
- Sibling passes: [`02-capture-and-shell.md`](./02-capture-and-shell.md),
  [`03-export-stack.md`](./03-export-stack.md),
  [`04-process-model-and-verdict.md`](./04-process-model-and-verdict.md). The brief:
  [`.claude/plans/rewrite-to-duckdb-stack.md`](../../.claude/plans/rewrite-to-duckdb-stack.md).
