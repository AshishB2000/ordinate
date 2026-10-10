# Subscriptions: scheduled sends to Slack and Teams

<sub>[← All operator docs](README.md)</sub>

A **subscription** posts a dashboard's figures to a Slack or Microsoft Teams channel on a schedule,
with a link back to the dashboard. The server sends it; nobody has to be signed in. An **alert rule**
can post to the same channels when it fires. This page is for the team that runs the server: what has
to be configured, how to make a webhook on each platform, exactly what leaves the server, and what
happens when a send fails.

In the app: **Subscribe** on a dashboard (or Reports → Subscriptions → New subscription) makes one;
Reports → Subscriptions lists them with their runs; **Admin → Channels** is where an org admin
connects a Slack or Teams channel.

## What the server needs

| Need | Why | Without it |
|---|---|---|
| `DATABASE_URL` | The schedule is a row in the `jobs` table, claimed by one pod at a time. Channels and subscriptions are records. | Nothing is scheduled. |
| `ORDINATE_MASTER_KEY` | A webhook URL is a credential, so it is stored only encrypted (the same envelope encryption as connection passwords). | Admin → Channels says the server cannot keep webhook URLs, and no channel can be added. |
| `ORDINATE_PUBLIC_URL` | The link in the message. It is never built from a request's `Host` or `Origin`. Under `AUTH_MODE=oidc` the origin of `OIDC_REDIRECT_URL` is used when this is unset. | Messages are sent without the link, and the Subscribe dialog says why. |
| Egress on 443 to the webhook hosts | Slack: `hooks.slack.com`. Teams: the host of the workflow URL (for example `*.logic.azure.com` or `*.api.powerplatform.com`; copy it from the URL). | Runs fail as "could not be reached". |

Every post goes through the same SSRF guard as connectors ([`SSRF_ALLOW`](configuration.md#limits-and-egress)):
a webhook URL that resolves to a loopback, private, link-local or metadata address is refused before
a socket opens. Slack's and Teams' hosts are public, so `SSRF_ALLOW` needs no entry for them.

All settings are in [configuration.md](configuration.md).

## Create a Slack webhook

1. Open <https://api.slack.com/apps> and choose **Create New App → From scratch**. Pick the workspace.
2. Under **Incoming Webhooks**, switch **Activate Incoming Webhooks** on.
3. Choose **Add New Webhook to Workspace**, pick the channel, and allow.
4. Copy the **Webhook URL** (`https://hooks.slack.com/services/T…/B…/…`).
5. In Ordinate: Admin → Channels → **Add a channel** → Slack, a name (use the channel's own, for
   example `#sales-weekly`), paste the URL, then **Send a test message**.

One webhook posts to one channel. Make one channel in Ordinate per Slack channel.

## Create a Teams webhook

Microsoft is retiring Office 365 connectors, so Ordinate posts to a **Workflows** webhook.

1. In Teams, on the channel, open **⋯ → Workflows**.
2. Choose the template **Post to a channel when a webhook request is received**, name it, and pick
   the team and channel.
3. Add the workflow and copy the URL it shows.
4. In Ordinate: Admin → Channels → **Add a channel** → Microsoft Teams, a name, paste the URL, then
   **Send a test message**.

The message is an Adaptive Card (version 1.4) in the envelope that template expects:

```json
{
  "type": "message",
  "attachments": [
    { "contentType": "application/vnd.microsoft.card.adaptive", "content": { "type": "AdaptiveCard", "version": "1.4", "body": [] } }
  ]
}
```

## Who can do what

| Action | Who |
|---|---|
| Add, edit, test or remove a channel | Org admins only. A channel is a way for data to leave the server. |
| See the list of channels, to pick one | Every member. They see the name and the platform, never the URL. |
| Create, edit, switch on or off, delete or **Send now** a subscription | Anyone with `write` on the project. |
| See a project's subscriptions and their runs | Anyone with `read` on the project. |
| Name channels on an alert rule | Anyone with `write` on the project (the alert dialog's **Also post to**). |

The webhook URL is write-only. It goes in when the channel is saved and is never returned, shown or
logged; the list says **Stored**. To change it, edit the channel and paste a new one.

A subscription has an **owner**: whoever created it. A run computes its figures with the owner's
access **as it is at that moment**. If the owner was disabled or removed, or no longer has access to
the project, the run fails with that reason and sends nothing. The next project writer to save the
subscription (or switch it back on) becomes its owner.

## What leaves the server

A message is text. There is no chart image and no file.

| Part | Content |
|---|---|
| Title and note | The dashboard's name (or the title the author typed), and the author's note. |
| Subtitle | The date, the saved view's name, the dashboard's filter line, and how fresh the data is. |
| KPI cards | The card's label, its figure as the card shows it, and, when the card has a Compare, the change with its direction and whether that direction is good. |
| Categorical visuals | The visual's name, the app's one-sentence caption, and the top 10 categories with their value and share of the total. |
| Time-series visuals | The latest value, its change from the previous point, and the range over the period. |
| Tables, pivots, cohorts, funnels | The first 10 rows and up to 5 measure columns. |
| Link | `ORDINATE_PUBLIC_URL` + the dashboard's path. Opening it needs a sign-in as usual. |
| Footer | The subscription's name and its schedule. |

What is **never** sent: a webhook URL, a connection's host or credentials, SQL text, dataset ids, row
dumps beyond the rows listed above, or anything a model wrote. Every figure is computed by the app's
own engines, the same ones that draw the dashboard. A Live dataset is asked of its warehouse, counts
against `LIVE_DAILY_QUERY_LIMIT`, and is never copied.

**The project's Share policy applies** (Settings → Privacy, the **Reports** path): a visual that reads
a column marked sensitive is dropped with "Hidden by the share policy", or its categories are masked,
exactly as in an exported report.

**Limits.** Slack takes 50 blocks and 3,000 characters per block; a Teams webhook takes about 28 KB.
A message that would not fit is cut — rows first, then whole sections — and says
"+N more in the dashboard". The Subscribe dialog's preview shows the cut and the size before saving.

**Untrusted text.** A category, a card title or a note cannot ping a channel or pass as a link the
app wrote. For Slack, `&`, `<` and `>` are escaped (so `<!channel>`, `<@U…>` and `<url|label>` arrive
as text) and `@channel`, `@here` and `@everyone` are broken with a zero-width space. For Teams, all
such text goes in `TextRun` elements, which Teams shows literally; nothing is put in a Markdown
`TextBlock`. The only link is the button the server built.

## Schedules, late runs and missed runs

A schedule is hourly, daily, on weekdays, weekly on chosen days, or monthly on a day (a shorter month
sends on its last day), at a time of day, in an IANA time zone. Daylight saving follows the zone: a
daily 08:00 stays 08:00.

Each org's subscriptions are checked once a minute by the `subscriptions` job. One pod claims a check
under a lease, so two pods never send the same run twice; a pod that dies mid-run is retaken after its
lease, and the run it had already stamped is not sent again.

If the server was down at the scheduled minute, the newest slot is sent when it comes back **if it is
less than six hours late**, and recorded as **Missed** otherwise. A long outage sends at most one
message per subscription, never a burst.

Two optional conditions hold a scheduled run back (they do not apply to **Send now**):

- **Something changed**: skip when the figures are exactly those of the last send.
- **The data has refreshed**: skip when no dataset behind the message was refreshed since the last send.

## When a send fails

| What happened | What the server does |
|---|---|
| The webhook answers `429` | Waits for `Retry-After` (capped at 30 s) and tries again, up to 3 attempts. |
| The webhook answers `5xx`, or the connection drops or cannot be made | Tries again after 1 s, then 4 s. 3 attempts in all. |
| The webhook answers any other `4xx` | Stops at once. The URL was revoked or the payload refused; a retry would repeat it. |
| The webhook redirects | Stops. A redirect is not followed. |
| The address is internal | Refused by the SSRF guard before a socket opens. |
| The owner has no access, the dashboard or every channel is gone, or the figures cannot be computed | Nothing is sent; the run is recorded as failed with that reason. |

A subscription that posts to several channels counts as sent when at least one took it; the run says
which channel failed.

**After five failed scheduled runs in a row a subscription pauses itself.** It is switched off, shows
**Paused** with the reason in Reports → Subscriptions, and its owner gets a notice in the app. Fix
the cause (paste a new webhook URL, restore access) and switch it back on; the count starts over.

**Where to look.** Reports → Subscriptions → ⋯ → **Runs** keeps the last 20 runs of each subscription:
when, whether scheduled or sent by hand, and the outcome in words. What the remote answered (status
and the first 500 characters of the body) is in the server log only, at `warn`, with the webhook URL
cut out:

```json
{ "level": 40, "channel": "#sales-weekly", "status": 404, "attempt": 1, "body": "no_service", "msg": "subscription post refused by the remote" }
```

Every attempt to send is also a row in the audit log (Admin → Audit log): channel
`subscription:send` with the owner as the actor, or `alerts:post` for an alert, and the ids of the
subscription or rule and its channels.

## Alerts

An alert rule that names channels posts there when it fires after a scheduled refresh: the rule's
name, the alert's own sentence, the figure, and a link to the dashboard the rule was made on. Nothing
is retried beyond the three attempts above and nothing pauses; the alert is in the inbox either way.

## Removing a channel

Admin → Channels → ⋯ → **Remove** lists the subscriptions and alert rules that post to the channel
before it asks you to confirm. Removing it deletes the stored URL. Subscriptions that named it keep
running to their other channels; one with no channel left fails with that reason and pauses.

To rotate a webhook URL without breaking anything, edit the channel and paste the new URL instead.
