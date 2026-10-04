# Backup and restore

Ordinate keeps its state in three places. A complete backup covers all three:

| What | Where | Holds |
|---|---|---|
| **Postgres** (`DATABASE_URL`) | your RDS / Cloud SQL / Compose volume | Users, roles, teams, project grants, sessions, API tokens, the audit log, jobs. Every record: projects, dataset metadata, visuals, dashboards, pipelines, versions, trash. Encrypted secrets: connection passwords and AI keys. The table **version pointers**. |
| **Object storage** (`STORAGE_URL=s3://…`) or the `DATA_DIR` volume | your bucket or volume | The Parquet tables: immutable objects `…/orgs/<org>/<project>/<id>.<version>.parquet` on S3, or files under `DATA_DIR` without S3. |
| **`ORDINATE_MASTER_KEY`** | your Secret / Secrets Manager / `.env` | The key that unwraps every stored secret. A database backup without it restores everything except connection passwords and AI keys, which are then unreadable and must be re-entered. |

You do not need to back up the pods, the image or, in S3 mode, the `/data` volume. It is a cache
plus temp files, rebuilt on demand.

## Consistency between Postgres and the bucket

A table write puts a **new** object under a fresh version key, then switches the record's pointer
in Postgres. Objects are never modified in place. The `storage:gc` job deletes a version only once
no record has named it for `STORAGE_GC_GRACE_MINUTES` (60 by default). It runs every 15 minutes.

- **Back up Postgres first, then the bucket**, and finish the bucket copy within the grace period.
  The copy then contains every object the dump points at.
- **Turn on bucket versioning**, with a noncurrent-version expiry longer than your oldest database
  backup. Restoring an older database onto the live bucket can point at versions GC has since
  deleted. With versioning, those deleted objects can still be recovered.
- Without S3 (`DATA_DIR`), snapshot the volume and the database together.

## Postgres

**Managed Postgres:** use the provider's automated backups and point-in-time recovery (RDS, Cloud
SQL, Azure Flexible Server). Physical snapshots are unaffected by what follows.

**Logical dumps (`pg_dump`) need a role that bypasses row-level security.** `records` and
`storage_objects` have **forced** RLS, keyed on a per-transaction setting the app makes. The app's
own role, an ordinary role that owns the database, is held to it on purpose. Measured on Postgres 17
(T7.3):

| `pg_dump` as | Result |
|---|---|
| the app's owner role | fails: `query would be affected by row-level security policy for table "records"` |
| the same role with `--enable-row-security` | **succeeds with zero rows**: a silent empty backup. Never use it. |
| a `BYPASSRLS` role, or a superuser | complete |

A backup role, made once by a role allowed to create `BYPASSRLS` roles (these statements ran on
Postgres 17 with different names, and `pg_dump` as that role then dumped all 16 tables with data):

```sql
CREATE ROLE ordinate_backup LOGIN PASSWORD '<password>' BYPASSRLS;
GRANT pg_read_all_data TO ordinate_backup;
```

To check what a role can do:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

On a managed service, check that the admin role may grant `BYPASSRLS` before relying on this. If it
may not, rely on snapshots.

## Compose: back up, restore, verified

Run these from `deploy/`. The whole sequence was run in T7.3, in this order: back up, `docker compose
down -v`, restore. Afterwards the same 7 records, 1 table object and 1 user were there, and the
dashboard drew its chart from the restored Parquet without a console error. The restore took 18 s.

**Back up:**

```bash
docker compose exec -T postgres pg_dump -U ordinate -Fc ordinate > ordinate.dump
docker compose exec minio mc mirror --overwrite local/ordinate /tmp/ordinate-bucket
docker compose cp minio:/tmp/ordinate-bucket ./ordinate-bucket
```

Keep `.env` with the dump: it holds `ORDINATE_MASTER_KEY`. The Compose Postgres user is the image's
superuser, so `pg_dump` sees every row here.

**Restore** onto empty volumes:

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U ordinate -d ordinate < ordinate.dump
docker compose up -d --wait
docker compose cp ./ordinate-bucket minio:/tmp/ordinate-bucket
docker compose exec minio mc mirror --overwrite /tmp/ordinate-bucket local/ordinate
```

Restore Postgres **before** the server first starts. Otherwise it migrates an empty database, and
the restore then collides with those tables. The server logs `"applied":[]` when it finds the
restored schema current.

## Ordinate's own backups (Settings → Organization → Backups)

An org admin can download every project of the org as one zip. The zip holds each project's
ordinary `.ordinate` bundle (its records and Parquet tables) plus a `backup.json` listing them.
Uploading the zip again restores each project as a **new** project, "Sales (restored Oct 4, 2026)",
and never overwrites what is there. Downloads and restores are audited.

It is a portability and self-service tool, **not disaster recovery**. The bundle is a whitelist,
and it leaves out:

- users, roles, teams, grants, API tokens, sessions and the audit log;
- connection passwords and AI keys (connections come back without their secret, under fresh ids);
- org settings, the Trash and Assistant conversations.

Two practical limits:

- The backup is built in memory (threat model R3).
- The restore upload goes through `POST /api/files`, so a zip larger than `MAX_UPLOAD_MB` (200 MB by
  default) cannot be restored until that cap is raised.

## Master key

Store `ORDINATE_MASTER_KEY` where your other root secrets live, separately from the database
backups. To rotate it, re-wrap every org's data key from the old key to the new one. Secret
payloads are untouched. From `src/server/secrets/rotate.ts`:

```
DATABASE_URL=… \
ORDINATE_MASTER_KEY_OLD=<current key> ORDINATE_MASTER_KEY_NEW=<new key> \
node src/server/secrets/rotate.js            (or: npm run secrets:rotate)
```

Then roll every pod with the new key, and run the command once more. It re-wraps anything an old
pod created meanwhile, and prints 0 when nothing is left. Only then destroy the old key. The
command is idempotent. A data key under a key that is neither OLD nor NEW aborts the whole run
with nothing changed.
