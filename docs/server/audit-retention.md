# Audit log: what it holds, and how long

Admin → Audit log is a **compliance trail**: who did what, to which records, when, and whether it
worked. It is not a debug log.

## What a row holds

| Field | Example |
|---|---|
| when | `2026-10-24T13:53:02Z` |
| who | the member's email (`jobs@system` for a scheduled run, `embed` for an embed view) |
| what | a sign-in, a sign-out, or the call's channel (`dataset:delete`) |
| project | the project the call was authorized against |
| ids | the records the call named (UUIDs from the input's `id` / `…Id` keys) |
| outcome | `ok`, `denied` or `error` |
| request | the request id, the same `reqId` as on the server's log lines |

A row never holds an input value. Inputs carry data rows, formulas, URLs and connection passwords,
so storing them would put customer data and secrets into the trail. SOC 2, ISO 27001 and HIPAA ask
for who, what, when and the outcome, not the payload. `src/server/authz/audit.ts` decides what a row
may hold; the caller cannot add to it.

To see what happened inside a request, search the server log for its request id.

## The `audit` log line

Every row is also written to the server log, as one JSON line with the same fields:

```json
{"level":30,"msg":"audit","audit":{"org":"acme","actor":"ana@acme.com","action":"rpc","channel":"dataset:delete","projectId":"87c88b78-…","targets":["929646dd-…"],"outcome":"ok","requestId":"req-bu"}}
```

Your log system (CloudWatch, Datadog, Loki, OpenSearch) can keep these for as long as your policy
says, and search them by any field. This is how Grafana Enterprise does it, and it is the long-term
archive: Ordinate does not copy old rows to S3.

## Retention in Postgres

`AUDIT_RETENTION_DAYS` ([configuration](configuration.md#metadata-database-and-secrets)) sets how
long rows stay in Postgres. Unset or `0`, the default, keeps every row, as before this setting
existed, so an upgrade never starts deleting a trail. The smallest other value is `30`.

When it is set, the shared sweep (every 5 minutes, one pod per org) deletes that org's rows older
than the limit, up to 200,000 per pass in batches of 5,000. A large backlog, from turning it on
over years of rows, clears over the next passes. One setting covers every org on the server.

Metabase (`MB_AUDIT_MAX_RETENTION_DAYS`), Superset (`prune_logs`) and Tableau Server
(`wgserver.audit_history_expiration_days`) handle it the same way: a time window in their own
database, with older rows deleted.

## Not built

- **Table partitioning.** The table is indexed on `(org_id, at)`. Partition it only when a
  measurement shows the delete or the audit screen slowing down, and record that measurement here.
- **Per-org retention.** One install usually belongs to one company. Add it if several customers
  share an install.
- **Archive to S3.** The log line above is the archive.
