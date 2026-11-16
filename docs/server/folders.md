# Shared folders

<sub>[← All operator docs](README.md)</sub>

A project's datasets and dashboards can sit in **folders** shared with **teams**. Everything starts in **Everyone in
the project**, which every project member opens at their project role, as before folders existed. A project admin
makes a top-level folder such as *Finance* and gives teams *Can view* or *Can edit* on it; only those teams' members
(and admins) then open what is moved into it. This page is for the people who run the server and the project admins
who set folders up. The design, with every reader and how each is covered, is
[`docs/team-folders/00-design.md`](../team-folders/00-design.md).

## What the server needs

| Need | Why | Without it |
|---|---|---|
| `DATABASE_URL` | Folders are Postgres rows (`folders`, `folder_grants`, `folder_items`, migration `0032`), and teams live in Postgres. | There are no teams and no folders: every list is the project's, Share → Folders says folders need a database, and every folder change is refused. |
| Every pod on a release with the folder readers | A pod that cannot apply a folder shows a folder's items to every project member. | See [Upgrading](#upgrading-and-rolling-back). |
| `ORDINATE_FOLDERS=on` | Making folders, giving them to teams, their reach switch and moving items into them are off until an operator turns them on ([configuration.md](configuration.md#shared-folders)). | Those changes are refused with "Folders are off on this server: an operator turns them on once every server runs this version.", and the rail's New folder, Move to…, Share → Folders' team and reach controls and Admin → Teams → Folders' levels are hidden behind one line saying so. Folders made while it was on keep applying, and can still be seen, renamed and deleted. |

No port or secret. Teams come from Admin → Teams, or from your identity provider's groups
([sso.md](sso.md)), so a new hire in the IdP group gets the team's folders on their next request.

**When to turn it on:** once every pod runs a release with the folder readers (shared folders E1–E6: the release
that brings this setting has them), set `ORDINATE_FOLDERS=on` on every pod in one rollout. During that rollout a
pod still `off` refuses a change another pod allows; nothing widens, and a retry lands on an `on` pod.

## Who can do what

| | Org admin, project admin | Project editor | Project viewer |
|---|---|---|---|
| Open a folder | every folder (a lock and *Admin access* in the rail when none of their teams was given it) | Everyone, and folders their teams were given | the same, read-only |
| Make, rename or delete a **top-level** folder, give it to teams, set its switch | yes | no | no |
| Make, rename or delete a **subfolder** | yes | with *Can edit* on its folder | no |
| Move a dataset or dashboard | anything | with *Can edit* where it is and where it goes | no |

- A person's level on a folder is the highest their teams were given, **capped by their project role**: a project
  viewer in a team with *Can edit* still only views. No project role, no folder.
- Subfolders have no grants of their own: they open to whoever opens the top-level folder they are in. Folders go at
  most 5 levels deep, a project holds at most 1,000, and names are unique among siblings (whatever the case).
- What is not placed follows what it is about: a chart, metric, glossary term or verified question follows its
  dataset; saved views, subscriptions, alerts and comments follow their dashboard; stories, scorecards and reports
  follow every dataset they show.
- **A dashboard in one folder may show charts of a dataset in another**: its viewers see those charts and figures,
  never the dataset itself. A top-level folder's switch, *Dashboards in other folders may show this folder's data* (on
  by default), turns that off for data that must stay inside it.

## Moving, and the warning

**Move to…** on a dataset row, a dashboard card or an item's folder chip, or a drag onto the folder rail, first shows
what changes: the teams (and head counts) that lose or gain access, who can only view it afterwards, published links
(a `/p/` page and its embeds keep the audience chosen when it was published), subscription email recipients who stop
receiving a dashboard, and dashboards elsewhere that show a moved dataset's charts. The move carries a hash of that
warning; if a grant, a team or a placement changed in between, the server refuses it and the dialog shows the new
warning to agree to. A folder is deleted only when it is empty, the Trash included: deleting never moves anything on
its own, because that could show items to more people.

**Publishing and subscribing say who can't open it.** A `/p/` page and its embeds keep the audience chosen at Publish
(the link's), so the Publish dialog and the Embed dialog say *Shows data from folders N people can't open* when the
dashboards on the page, or the datasets they read, sit in folders that N project members (not admins) cannot open, and
nothing when there are none. The Subscribe dialog says *N recipients can't open this dashboard and won't get it* for
the email lists picked: those people are left out at send time. Both are counts from the server, never names.

Every folder change is a `write` or `admin` call and lands in the audit log (`folder:create`, `folder:grant`,
`folder:move` …) with who made it ([audit-retention.md](audit-retention.md)).

## Upgrading and rolling back

- **Every pod has the folder readers before anyone can make a folder.** Folders can be made only with
  `ORDINATE_FOLDERS=on`. A pod of a release without the readers ignores folders and shows every folder's items to every
  project member, so never run one beside a pod that can make folders: upgrade every pod with the setting off, then
  turn it on ([upgrade.md](upgrade.md)).
- **Never roll back below the readers' release once a project has a folder.** If you must, with `ORDINATE_FOLDERS`
  still on, a project admin first opens **Share → Folders → Move everything to Everyone** in each project with folders:
  every item, the Trash included, goes back to Everyone (the warning shows who gains access), the folders stay empty,
  and the rollback then widens nothing. Turning `ORDINATE_FOLDERS` off alone does not: folders already made keep
  applying, and an older pod ignores them.
- Rolling back between releases that both have the readers is safe: the tables stay.

## Backups and bundles

A Postgres backup carries folders, grants and placements ([backup-restore.md](backup-restore.md)). A project bundle
(Export project) and a restore into a new project carry **no** folders: the new project's only grant is its creator's,
so everything landing in Everyone widens nothing. Deleting a project drops its folders, grants and placements.
