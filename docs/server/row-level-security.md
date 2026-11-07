# Row-level security

<sub>[← All operator docs](README.md)</sub>

A project's datasets can carry **row access rules**: one column of the dataset, and for each user or
team the values of that column they may see. A regional dashboard can then be shared with every
regional manager in one project, each seeing only their region, instead of one copied project per
region. This page is for the people who run the server and the project admins who set the rules.
The design, the full list of every reader and how each is covered, is
[`docs/row-policy/00-design.md`](../row-policy/00-design.md).

This is **phase 1**: rules are enforced for people who open Ordinate themselves. Anything that
computes figures once and sends them to many people — published links, embeds, subscriptions,
alerts — is **off** for a dataset with rules (see below).

## What the server needs

| Need | Why | Without it |
|---|---|---|
| `DATABASE_URL` | Rules name users and teams, which live in Postgres, and who is a viewer comes from the project's grants. | There is no user directory: the Access tab says so and no rule can be set. (A server without Postgres has only the dev sign-in, where everyone is an admin.) |

Nothing else: no new environment variable, no migration, no new port. Rules are stored in the
dataset's own record, so a backup or a project bundle carries them.

## Who is restricted

| Role on the project | What they see on a dataset with rules |
|---|---|
| Org admin, project **admin**, project **editor** | Every row. Only admins can change the rules; editors cannot, but they can change the dataset's prepare steps (and so the rule column) and read every row through them, so restricting them would protect nothing. |
| Project **viewer** (granted directly or through a team) | Only the rows whose rule column holds one of **their** values: the union of every rule that names them or a team they belong to. |
| A viewer that no rule names | **No rows.** Every figure over that dataset says "You don't have access to any rows of this dataset." |

Under SSO every new user joins as a viewer, so rules apply to them from their first sign-in. A
role or team change takes effect on the person's next request.

## Set rules (project admins)

1. Open the dataset → **Access**. Only project admins see this tab. Row rules come first on it;
   [Hide a column](#hide-a-column) is below them.
2. Pick the **column** the rules are about — a text column such as `region`, `customer_id` or
   `cost_center`.
3. **Add a rule** per user or team: pick the member, then the values they may see. You can type a
   value that has no rows yet.
4. **Save.** The change is audited (Admin → Audit log, channel `dataset:setRowPolicy`).

How values match:

- **Exactly**, case and spaces included: `East` is not `east` or `East `.
- A row whose column is empty is in no one's rows.
- A person in two teams with rules sees the rows of both.

The rules stop holding, and every viewer is **refused** rather than shown more, when:

- the column is renamed, removed or retyped (the tab warns: pick the column again);
- the dataset's prepare steps store a value computed across rows — a running total, rank or
  share of total not partitioned by the rule column, a group-by or pivot that does not keep it, a
  segment, a level-of-detail field (`{FIXED …}`), top terms. Those values were computed over every
  row, so no filter can make them one region's. Partition the window by the rule column, or keep
  the column in the group-by, and it works again;
- the steps read a dashboard parameter;
- the dataset is built by SQL, a notebook or the composer, or one of its steps looks up another
  dataset — phase 1 cannot filter rows that were mixed before they were stored;
- an editor changed a step that writes the rule column (for example a find-and-replace on it) after
  the rules were saved. The tab says so: **save the rules again** after checking the step.

## Hide a column

A project admin can also hide a **column**: its values, and every figure computed from it, from
everyone the rule does not name. Use it for a `salary` or `ssn` column that most people who read
the dataset should not see, where row rules would hide whole rows instead.

**Who is restricted** is the same as for rows: project viewers. Org admins, project admins and
project editors see every column. A rule is an **allow-list**: the users and teams it names see the
column; every other viewer does not, including someone added to the project later. A rule that
names no one hides the column from every viewer.

**Set it:** open the dataset → **Access** → *Who sees each column* → **Hide a column…**, pick the
column and who can see it, and **Save**. The Access tab suggests the columns marked personal or
financial on the Columns tab ("ssn is marked sensitive. Hide it from viewers?"); one click hides
such a column from every viewer, and **Edit** then names who sees it. **Stop hiding** asks first.
Each save is audited (Admin → Audit log, channel `dataset:setColumnAccess`). The rules are not
versioned: the audit log is their history.

**What hiding protects:** the column's values and every figure computed from it, never its
**name**. Names already sit in chart definitions, notes, version diffs and comments; rename a column
in Prepare if its name is itself sensitive.

**Columns computed from it are hidden too.** When the rules are saved, the server finds every
column a Prepare step computes from a hidden one (a formula such as `bonus_pct = [salary] / 1000`, a
rename, a split, a pivot) and hides it from the same people. The tab lists such a column read-only:
`bonus_pct · Only: HR (hidden too: computed from salary)`. A rule an admin types on such a column
may name fewer people than its source, never more: the save says so.

**When the rules stop holding**, the dataset is closed to every viewer it hides a column from
(they see "Some columns of this dataset are limited to certain people…") until an admin acts:

- **A Prepare step that reads a hidden column changed**, or a new one computes a column from it.
  The tab says so: check the step, then **Save again** (the new columns are hidden with it).
- **A hidden column is gone** (renamed or removed, or a Live warehouse dropped it). A source rename
  may have moved the data to a new name, so the tab names the column: stop hiding it, or hide the
  column under its new name.

**What a viewer it hides a column from sees:**

- A chart, KPI, metric, Explore question or Assistant answer that uses the column (or one computed
  from it) says "This uses a column a project admin has limited to certain people, so it can't be
  shown here." Everything else draws as before, with figures equal to an editor's.
- The data grid leaves the hidden columns out and says "3 columns hidden" (the names on hover); a
  search of the grid is off for them. The rows behind a chart mark, and their CSV, leave them out.
  The Columns tab lists each with a lock and no example or value labels.
- The Assistant and MCP agents never get the column, its values, its notes or a figure computed
  from it, nor the metrics and glossary terms that read it; a tile on such a metric says why.
- What reads the whole table — SQL, statistics, key drivers, insights, quality results, snapshot
  comparisons, exports — is off for them on that dataset, and on every dataset built from it (the
  Access tab lists those).

**Published links, embeds, subscriptions and alerts** refuse only when they **read** a hidden
column: a dashboard of headcount by department over the same dataset still publishes and sends.
A page published **before** column rules were set on a dataset it reads stops being served until it
is published again; a cached embed is checked again on every view.

**A ceiling:** a column that a hidden one was computed **from** is not hidden. If `salary` is
`base + bonus`, hide `base` and `bonus` too.

**Upgrading:** column rules need every pod on the release that applies them. A pod of the release
before it keeps the rules and closes the dataset to viewers (see
[the upgrade note](upgrade.md#certification-and-hidden-columns-a-newer-release-writes-are-kept-p4-01a));
an older pod would show every column and drop the rules. Once rules exist, **never `helm rollback`
below that release**.

## What a restricted viewer sees and does not see

**Filtered to their rows:** every chart and KPI on a dashboard, a visual, Explore, an Assistant
answer card, a metric and its values, a metric tree's figures, a scorecard's figures, a story's
figures; the dataset's data grid and the rows behind a chart mark (and their CSV download); every
filter list's values; the column profile panel.

**Off for them on that dataset**, with a sentence saying why: SQL (the workbench and the MCP
`query_sql` tool), statistics, key drivers, segments, scenarios, insights, the Summary card,
quality results, snapshot comparisons, Prepare previews, the column statistics, AI suggestions,
Assistant questions about the dataset, looking at past data ("as of"), questions that reach a
related dataset, and exports (dashboard HTML, story and report files). On a dashboard a refused
tile says why and every other tile still draws.

**Still visible to everyone with access to the project** — rules hide rows and the values in them,
not:

- the dataset's name, its columns and types, and its **total row count**;
- anything a person typed: titles, notes, column notes, comments (including the chart point a
  comment is pinned to), filter values saved in a dashboard, a visual or a saved view;

## Datasets built from one with rules

A dataset built FROM a dataset with rules — a SQL dataset, a notebook cell, a composed or combined
dataset, or one whose prepare steps append or look up the protected dataset, however many steps
removed — is **closed** to restricted viewers ("This dataset is built from a dataset with row access
rules…") and to published links, embeds, subscriptions and alerts, until a project admin gives it
rules of its own. A **copy** of a dataset with rules ("Make a copy" of a Live dataset, a duplicate)
starts with the same rules. The Access tab lists the datasets built from the one you are on.

## Off for a dataset with rules (phase 1)

These compute once and reach people whose rules differ, so they refuse — for everyone, admins
included — when they read a dataset with rules:

| Feature | What happens |
|---|---|
| **Published links** (`/p/…`) | Publishing refuses and the Publish dialog says why. A page published **before** the rules were set is no longer served; a page published before this release is not served while its project has any dataset with rules, until it is published again. |
| **Signed embeds** | The embed shows its refusal page. A page cached in the last five minutes is checked again on every view. |
| **Subscriptions** (Slack, Teams, email) | Saving refuses; an existing subscription's next run fails with the reason and the owner is told. Nothing is posted. |
| **Alerts** | Saving refuses; an existing rule is paused with the reason. Alert events about the dataset reach the in-app inbox without their figures. |

Phase 2 sends each recipient their own figures; until then, share a dashboard over such a
dataset by granting people access to the project.

## Live datasets

Rules work the same on a Live dataset: the rule becomes part of the query sent to the warehouse,
every value a bound parameter. A cached warehouse answer is kept per set of rows, so a viewer never
receives another viewer's cached figure. The column profile's sample values are not shown to a
restricted viewer. The rule column must still exist in the warehouse; if a schema sync finds it
gone, viewers are refused until an admin picks another.

## Troubleshooting

| Symptom | Cause |
|---|---|
| A viewer sees "You don't have access to any rows of this dataset." | No rule names them or one of their teams. Add one, or add them to a team that has one. |
| Every viewer is refused with "…name a column it no longer has…" | The rule column was renamed, removed or retyped. Pick the column again in Access. |
| A viewer is refused with "…limited to certain people, and this can't keep to that…" | A column is hidden from them and the feature reads the whole table (SQL, statistics, an export), or the column rules stopped holding: Access says why (**Save again**, or a column that is gone). |
| Every viewer is refused with "…values computed across all of its rows…" | A prepare step stores a cross-row value or reads a parameter (see *Set rules*). |
| Every viewer is refused with "…built from a dataset with row access rules…" | The dataset is derived from one with rules. Give it rules of its own (and, for a SQL or composed dataset, expect phase 1 to refuse viewers anyway). |
| A viewer still sees a total for all regions somewhere | Check it is the total row count (always visible) or text someone typed. Anything else is a bug: report it. |
| Publishing, a subscription or an alert refuses | Expected in phase 1 for a dashboard that reads a dataset with rules. |

## Refutation round

Before any code, a separate reviewer tried to break the design. Its findings changed what this page
describes: a data refresh can no longer overwrite rules saved during it; datasets built from a
dataset with rules are closed rather than open; SQL, notebook and composed datasets and lookup steps
count as mixing rows; a step that rewrites the rule column after the rules were saved closes the
dataset until an admin saves again; Prepare's step list is not shown to restricted viewers; Live
warehouses compare the rule's values byte for byte, whatever their default collation. The full
list, finding by finding, is in [the design](../row-policy/00-design.md#refutation-round).
