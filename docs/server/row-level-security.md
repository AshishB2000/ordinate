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
| `DATABASE_URL` | Rules name users and teams, which live in Postgres, and who is a viewer comes from the project's grants. | There is no user directory: the Row access tab says so and no rule can be set. (A server without Postgres has only the dev sign-in, where everyone is an admin.) |

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

1. Open the dataset → **Row access**. Only project admins see this tab.
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
starts with the same rules. The Row access tab lists the datasets built from the one you are on.

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
| Every viewer is refused with "…name a column it no longer has…" | The rule column was renamed, removed or retyped. Pick the column again in Row access. |
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
