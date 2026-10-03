# Phase 7 log

Append-only. One entry per task: date, task id, what was measured, what was decided and why.

## 2026-10-02 — T0.1 Server skeleton

- **Measured** (5 runs, `node src/server/main.js`, PORT=0): cold start to listening 67–69 ms; first
  `/readyz` 46–61 ms (one-off DuckDB worker start, blocks the loop once); warm `/readyz` ~1 ms.
- **Dependency:** `fastify ^5.12.5` only. Its transitive `ajv`, `fast-uri`, `json-schema-traverse`,
  `require-from-string` move from dev to prod in the lockfile. The other `@fastify/*` plugins land
  with the task that first uses them.
- **Decided:** `DATA_DIR` is required in `prod` (a pod writing to its container filesystem loses
  every dataset on restart); dev defaults to `./data`. Dev binds `127.0.0.1` because T0.3's dev auth
  makes every request an admin; prod binds `0.0.0.0`. Unknown env *names* are not rejected (each
  later task adds variables), only invalid *values* — one `ordinate: …` line, exit 1.
- **Log redaction** is pino exact-key paths at depths 0–4 for authorization, proxy-authorization,
  cookie, set-cookie, x-api-key, password, token, secret, key. `apiKey`/`accessToken`-style names
  are not matched; a walking serializer is the upgrade if a handler ever logs such an object.
- **No-Electron proof:** `test-server-boot` spawns the server with a preload that makes
  `require('electron')` throw (negative control included); `/healthz` and `/readyz` are 200.

## 2026-10-02 — T0.2 RPC registry, contracts and wire codec

- **Bulk edit (scripted, orchestrator):** 80 `src/ipc/*.ts` take `ipcMain` from `./bus` — 53 one-line
  swaps, 27 split imports. Only `ipcMain.handle` (405 sites) and `ipcMain.on` (11) exist.
- **Wire format:** body = wire-encoded `{ args: [payload?] }`; the contract's zod input validates
  `args[0]`; handler called as `handler(SERVER_EVENT, parsed)`. 404 no contract (even with a handler
  registered), 400 `{error, issues:[{path, code}]}` — paths and zod codes only, never values or
  messages; 501 contracted-but-unregistered; 500 handler failure (message to the log only).
  Tags `{"$":…}` for NaN/±Inf/-0/undefined/holes/BigInt/Date/Map/Set/Uint8Array; an object with its
  own `$` key is escaped (`{"$":"O"}`), and decode uses `defineProperty` so `__proto__` stays a key.
  `Buffer` decodes to a plain `Uint8Array` — what `structuredClone` and Electron IPC give.
- **Measured** on the largest real reply (`stats:run` regression, 80,456 bytes, 50-run mean):
  encode 0.33 ms, decode 0.17 ms; plain JSON round trip 0.37 ms; structuredClone 0.22 ms. Plain JSON
  would have silently changed 3 of the 28 real replies tested (`category: undefined` on the
  choropleth's viz data, `periodKey: undefined` in insights) — the codec is not optional.
- **Decided:** one payload argument per contract (plan §4). Nine handlers take more than one
  (`filterParse:parse`, four `format:colors:*`, `incremental:set`, three `privacy:*`) — tuple inputs
  when their screens port. `Uuid = z.guid()` (matches the repo's version-agnostic `UUID_RE`).
  Registry throws on a duplicate `handle`, as Electron does.
- **21 test suites** captured handlers through a fake `ipcMain` in their Electron stub; they now read
  the registry's map. No assertion removed.
- **Open for T0.3:** `registerHandlers()` (lazy requires) is not called from `main.ts` yet — the
  Home modules' import graph has 26 Electron importers: 20 only `app` (T0.3's `paths.ts`), and 6 more
  (`net` in `ai/analyze*`, `nativeImage` in `cli/localCliRun`, `dialog` in `ipc/projects`,
  `ipc/datasetImport`, `ipc/backups`, plus `shell`/`BrowserWindow` in `backups`).
- **Local infra:** Postgres 17 and MinIO installed via Homebrew as services (user's choice) so P3/P5
  tasks test locally; Compose/Helm verify in CI.
