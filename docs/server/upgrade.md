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

Between releases, `ghcr.io/ashishb2000/ordinate:edge` is the latest commit on `develop` that passed
CI, built and booted the same way. It moves on every merge and has no chart: use it to try a change
early, never in production.

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
- **Skipping releases** (0.2 → 0.5) is fine for the schema. Missing migrations apply in order, in
  one transaction. A rolling update can still run old and new pods side by side, so a section below
  may name a release to pass through first. Read
  [Filters a newer release writes are kept](#filters-a-newer-release-writes-are-kept-05a) before
  you skip.

## Sticky sessions are no longer needed (`0021_any_pod`)

Releases before `0021_any_pod` held uploads, downloads, staged imports and Assistant plan runs on the
pod that started them: keep sticky sessions on those. From this release any pod serves any request.
Remove the stickiness after the rollout, and add the S3 lifecycle rules in
[eks.md](eks.md#2-s3-and-irsa).

## Filters a newer release writes are kept (`05a`)

Some releases add a new kind of saved data: a new kind of filter, a note on a table, a name on a
join. Before this release, a pod (one running copy of the server) that did not know the new field
dropped it the next time it saved that record. In a rolling update, old and new pods run side by
side for a while, so an old pod could erase what a new pod had just written.

From this release, a pod **keeps a filter step of a kind it does not know**, and the specific saved
data listed under [Other saved data this release keeps](#other-saved-data-this-release-keeps),
exactly as it was. It **refuses the figure that needs it**. Where the figure would be, you see a
sentence such as "This figure uses a filter from a newer version of Ordinate. Finish the upgrade,
then try again." For these, nothing is dropped and no wrong number is drawn.

That is all it promises. A new field on a kind of data this release already knows is still dropped,
as before. So is a filter step that is over 2 KB or is not plain JSON, and so is a Prepare step (a
step that cleans a dataset) of a kind it does not know.

### The release that adds glossary terms needs this release first

A glossary term is a named filter that charts refer to by name. **The release that adds terms needs
this release (or a later one) on every pod first.** A pod older than this one reads a term as no
filter, so the chart is drawn unfiltered. It also deletes the term from the chart when anyone saves
it.

Nothing in the server can check this, because it keeps no list of the pods that are running. The
project holds the order itself: the maintainers cut every release, and the change that adds terms
does not merge until a release containing this one is tagged. You hold it on your side. From an
older release, do one of these:

- **Go through this release.** Upgrade to it and wait for the rollout to finish
  (`kubectl -n ordinate rollout status deploy/ordinate` on Helm). Only then upgrade to the next one.
- **Stop every pod, then start the new ones.** There is a short outage, but no old pod ever runs
  beside a new one.
  - **Compose** already does this. `docker compose up -d` recreates the container.
  - **Helm:** scale to 0, wait until the pods are gone, then upgrade. The migration Job still runs
    first.

    ```bash
    kubectl -n ordinate scale deploy/ordinate --replicas=0
    kubectl -n ordinate wait --for=delete pod \
      -l app.kubernetes.io/instance=ordinate,app.kubernetes.io/component=server --timeout=120s
    helm upgrade ordinate ordinate-<new version>.tgz -n ordinate -f values.yaml --wait --timeout 10m
    ```

    `scale` returns at once, so the `wait` is what makes sure no old pod is left. If it says that
    nothing matches, the pods are already gone. If the migration Job fails while the pods are at 0,
    the app stays down. Scale it back up to your usual count (`replicaCount`), then read
    `kubectl -n ordinate logs job/ordinate-migrate`.

    With `hpa.enabled`, the chart does not set a pod count and the autoscaler does not start a
    deployment that is held at 0. Scale it back up yourself afterwards, to `minReplicas`.
  - **ECS:** set the service's desired count to 0 and wait for the tasks to stop. Then update the
    service to the new task definition, with the desired count back at its usual number. If the
    service uses Application Auto Scaling with a minimum above 0, set that minimum to 0 too (or
    suspend scaling) before you stop the tasks, or it starts them again. Put it back afterwards.

**Never roll back below this release once terms exist** (`helm rollback`, or an older
`ORDINATE_IMAGE` in Compose). An older pod reads a term as no filter and deletes it from a chart
when the chart is saved.

**Open browser tabs:** reload them after the upgrade. A tab still running the old web app does not
know the new filters, and it saves a filter list without the ones it cannot show.

### Other saved data this release keeps

None of these features exists in this release. It only reads and keeps what a later release will
write. Each item says what a pod older than this release does, and what this release does instead.

- **Join names, and `via`.** A join (a relationship) can have a name, and a chart can say which join
  it goes through (`via`). An older pod drops both: every name in the project is lost on its next
  join save or delete, and a chart with `via` is drawn through the first join, which can be the
  wrong date. This release keeps both, and refuses the chart (Explain declines it too). Saving the
  same join again keeps its name. A join edited onto other columns loses its name, because it
  described the old columns.
- **Always-applied filters on a [Live dataset](live-data.md).** An older pod ignores them and
  answers every question without them. This release refuses every question, schema sync, "Make a
  copy" and "Copy the data instead" on that dataset ("Ask your admin to finish upgrading
  Ordinate").
- **Notes on a table, labels for a column's values, and warnings on a join.** An older pod drops
  them the next time it saves a project's notes (any tag or note edit does) or a join. This
  release keeps the notes and the labels. The column notes a browser reads carry no value labels,
  so a viewer with row access rules never sees them, and a project bundle shaped by the Share policy
  (mask or drop) from this release carries none either. A join's warning is dropped when this release
  saves the join: it is worked out again later, so losing it never changes a figure.
- **A metric's date column, and the mark on a date filter that came from a dashboard's date
  control.** An older pod drops both. Renaming a metric or saving the metric tree erases its date
  column, and an alert saved from a KPI counts by the control's column instead of the metric's.
  This release keeps both. Where a dashboard's date control is on another column than the metric's
  own date, the later release counts by the metric's date, so this release gives no figure for that
  metric: it refuses a chart of it, Explain, an alert on it and its drivers ("This chart counts a
  metric by its own date, which this server cannot do yet"), and the metric's own KPI tile and the
  Summary card's KPI for it show none. Three places still give a figure: see
  [What stays open](#what-stays-open).
- **Snapshot metrics**, which take the last (or first) value by date, as for a balance, instead of
  adding every row. An older pod cannot read one, so it draws a sum over every date. A rename or a
  duplicate erases the setting. This release keeps it and shows no figure for it: a KPI shows none,
  the Summary card leaves it out, and charts, Explain, alerts, the metric tree and drivers refuse,
  until a later release adds snapshots. The one exception is under
  [What stays open](#what-stays-open).

### What stays open

For the data listed above, the gap is closed once every pod runs this release or later. It stays
open in two cases: an upgrade that skips this release without stopping all pods first, and a
rollback below it. Then an older pod runs next to data it cannot read, and the list above is what it
does. Some of that is lost data. Some of it is a wrong figure: a term or an always-applied filter
that is ignored, a chart with `via` drawn through the wrong join, an alert that counts by a
dashboard's date column instead of the metric's, and a snapshot metric summed over every date. If
you roll back below this release anyway, remove the always-applied filters from your Live datasets
first, and check the charts that use a named join afterwards.

These stay open even with every pod on this release, for as long as its pods run beside the
release that adds these features:

- **The metric editor's preview** on a pod of this release shows a plain total for a snapshot
  metric. The saved metric keeps its snapshot, and the figures listed above still show none for it.
- **Restoring an earlier version of a metric** on a pod of this release does not restore its date
  column: the metric keeps the one it has now.
- **Explain refuses a saved chart with more than 8 filters** instead of narrating it: it reads at
  most 8, and narrating fewer would describe a wider chart.
- **A metric that counts by its own date, under a dashboard date control on another column**, still
  gets a figure in three places on a pod of this release. It counts by the control's date there,
  while a pod of the later release counts by the metric's own date, until every pod runs the later
  release:
  - a KPI card's comparison period (the figure it compares with);
  - a what-if (scenario) card;
  - a formula built on such a metric, in a chart, in its drivers and in the Summary card.

## Logos, pictures and masking keys move into Postgres (`0018_blobs`)

Earlier releases kept three things as files under `DATA_DIR` on the pod that made them: the
workspace and dashboard logos, Image-card pictures, and each project's masking key (`salt.key`, the
key hash steps use). With the Helm chart's `emptyDir`, every pod had its own copy or none.

**Rolling out.**

- Logos and pictures become rows of `blobs`. A file an earlier release left on a pod's disk is copied
  into its row the first time that pod reads it, and the file stays in place. Until then, pods that
  never had the file still do not show it. Open Settings → Branding and each dashboard with a custom
  logo once per pod that took uploads, or upload them again.
- With `ORDINATE_MASTER_KEY`, each masking key becomes an encrypted secret. The first pod to need a
  project's key stores its own `salt.key`, or a new key if it has none. On an install with two or
  more pods, each pod had its own key. Whichever pod reads first wins, and the other pods' datasets
  are hashed again under that key the next time they refresh or their steps change.
- A damaged `salt.key` is never replaced. Hash steps in that project refuse with an error, where they
  used to skip and keep the raw column, until the file is deleted. Deleting it mints a new key, which
  changes every token in that project.
- Upload logos and pictures after the rollout ends. One uploaded to an old pod in the middle of it is
  a file on that pod's disk.

**Rolling back.**

- The older release reads files only. Logos and pictures uploaded since the upgrade are rows it
  cannot see. Files from before the upgrade are still on disk, so those come back.
- A masking key stored since the upgrade is invisible to the older release. It mints a new file key,
  so hash tokens change, and its hash steps skip again instead of refusing.

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
