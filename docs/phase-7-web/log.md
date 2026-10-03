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
