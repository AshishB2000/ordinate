# Upgrades and rollbacks

<sub>[← All operator docs](README.md)</sub>

## Versions

A release is a git tag `v<major>.<minor>.<patch>`, or `v1.2.3-rc.1` for a pre-release, cut by
`.github/workflows/release.yml`. Every release publishes:

- **The image** `ghcr.io/ashishb2000/ordinate:<version>` for linux/amd64 and linux/arm64. Before
  anything is pushed, each architecture is booted against Postgres until `/readyz` reports DuckDB
  and Postgres, and held under 600 MB. A non-pre-release also moves `:latest`. Pin a version in
  production, never `:latest`.
- **The Helm chart** `ordinate-<version>.tgz`, attached to the GitHub Release. Its `version` and
  `appVersion` both equal the tag, so by default it deploys the image of the same release.

The version is also `package.json`'s `version`. The server writes it into every backup's manifest,
and the release workflow refuses a tag that does not match it.

## How the schema moves

Migrations are plain numbered SQL files (`src/server/db/migrations/NNNN_name.sql`). Each run applies
the missing ones in order, **in one transaction under a Postgres advisory lock**
(`src/server/db/migrate.ts`):

- **Several pods booting at once never race.** One applies the migrations and the others wait on the
  lock, then find nothing to do. T7.2 measured 3 pods on a fresh database: one applied 8 migrations,
  and the others waited 178 ms and 435 ms.
- **A failed migration rolls back completely.** The next start begins from the same state.
- **History is locked.** A recorded migration whose file has changed refuses startup ("restore the
  file and put the change in a new migration"). So does a new file numbered below one already
  applied.
- **Migrations are additive.** A release adds tables, nullable columns or columns with defaults,
  and indexes. It never drops or renames what the previous release reads. This is what makes rolling
  updates and rollbacks safe: old pods keep serving against the new schema until the rollout ends.
  The single transaction also rules out `CREATE INDEX CONCURRENTLY`.

The server migrates on every boot. The Helm chart additionally runs the same migration as a
**pre-install / pre-upgrade hook Job** (`node src/server/db/migrateMain.js`), so a bad migration or a
bad setting fails `helm upgrade` before any pod rolls, and the old pods keep serving.

## Before any upgrade

1. Read the release notes.
2. Take a database snapshot (see [backup-restore.md](backup-restore.md)). It is the only way back
   from a migration that goes wrong.
3. Note the current Helm revision:

```bash
helm history ordinate -n ordinate
```

## Helm

```bash
helm upgrade ordinate ordinate-<new version>.tgz -n ordinate -f values.yaml --wait --timeout 10m
```

What happens, in order:

1. The hook Job migrates. On failure the upgrade stops there, and
   `kubectl -n ordinate logs job/ordinate-migrate` shows one line naming the problem.
2. The Deployment rolls with `maxUnavailable: 0` and `maxSurge: 1`. A new pod must pass `/readyz`
   before an old one goes, and old pods drain for 5 s (`preStop`) before SIGTERM.

Measured on kind:

| Measurement | Result |
|---|---|
| `/readyz`, probed through the Service every 100 ms during an upgrade (T7.2) | 267 of 267 answered OK over 27 s |
| Upgrade to an image carrying one new migration (T7.3) | 16 s. The hook logged `"applied":["0010_t73_probe.sql"]` |

## Rolling back

```bash
helm rollback ordinate <revision> -n ordinate --wait --timeout 10m
```

**A rollback changes the pods, never the schema.** The chart has no pre-rollback hook, so nothing
runs a migration backwards, and the older release's server starts against the newer schema. It
ignores tables and columns it does not know: its migrator checks only the files it ships, and
versions recorded above its own are left alone. Measured on kind (T7.3):

| Step | Result |
|---|---|
| Revision 1 → 2 (0.1.0 → 0.1.1 with an additive `0010` migration) | |
| `helm rollback ordinate 1` | 13 s |
| Hook Job | did not run again |
| Old pods | logged `"applied":[],"total":8` |
| Schema | still at version 10, `t73_probe` still there |
| `/readyz` and the compose e2e (sign in → import → chart → dashboard) on the rolled-back pods | both passed |

The limits:

- **A non-additive migration cannot be rolled back with Helm.** If a release ever had to drop or
  rename something, its notes will say so, and the way back is restoring the database snapshot taken
  before the upgrade. Everything written since then is lost.
- **Data written by the newer release in its new tables or columns is invisible** to the older one.
  When you upgrade again, it is still there.
- **A backup file made by a newer release** (Settings → Organization → Backups) may carry a newer
  format version. An older server refuses such a file as "from a newer version".
- **Skipping releases** (0.2 → 0.5) is fine. Missing migrations apply in order, in one transaction.

## Compose

From a checkout:

```bash
docker compose up -d --build
```

Or, with `ORDINATE_IMAGE` set to the new version in `.env`:

```bash
docker compose up -d --no-build
```

Both commands keep the named volumes. The new container migrates at boot before it listens. To roll
back, set `ORDINATE_IMAGE` to the previous version and run the second command again. The same
limits apply.

## Cutting a release (maintainers)

1. In a pull request to `develop`, set `package.json` `version` to the new version, and merge it.
2. Push a tag `v<version>` on that merge commit. `release.yml` validates the tag against
   `package.json`, builds and boots both architectures, and pushes the image to GHCR. It then
   packages the chart and creates the GitHub Release, or adds to it: `build.yml` (the desktop
   installers) publishes to the same Release on the same tag.
3. **The first release only:** the GHCR package `ordinate` is created private. In the package's
   settings, set its visibility to public (or give your clusters a pull secret), and check that it is
   linked to this repository. The image's `org.opencontainers.image.source` label links it.

A re-pushed tag waits for the run in progress (`concurrency`), then overwrites the same image tags
and re-attaches the chart.
