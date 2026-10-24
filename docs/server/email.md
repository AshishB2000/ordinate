# Email for subscriptions and alerts

<sub>[← All operator docs](README.md)</sub>

A [subscription](subscriptions.md) or an alert rule can send to an **email list** as well as to a
Slack or Teams channel. The server sends the email through **one SMTP relay you configure**: SES,
Office 365, your own Postfix, or any relay that takes SMTP. Ordinate never looks up MX records and never
delivers to a recipient's mail server itself.

An email list is made in **Admin → Channels → Add a channel → Email** by an org admin. It names
people and teams of the organization; nobody can type an address into it. Each send then goes only
to those of them who **can open the dashboard's project at that moment** (see
[Who receives an email](#who-receives-an-email)). This is the difference from Slack and Teams, where a
post reaches everyone in the channel.

## What the server needs

| Need | Why | Without it |
|---|---|---|
| `SMTP_HOST` and `SMTP_FROM` | The relay, and the sender. Set them in the environment, and the password in your Secret. | Email is not offered. Admin → Channels shows Slack and Teams only, and the server refuses an email list. |
| `DATABASE_URL` | Recipients are the organization's people and teams, which live in Postgres. | Email stays off. The server logs a warning at start. |
| `ORDINATE_PUBLIC_URL` | The **Open in Ordinate** button in the email. | The email is sent without the button. |
| Egress to the relay's port | 587, 465 or 25, on the relay's address. A relay on a private address needs **no** `SSRF_ALLOW` entry. | Sends fail as "could not be reached". |

Every variable is in [configuration.md](configuration.md#email).

## TLS

| `SMTP_SECURITY` | Port (default) | What happens |
|---|---|---|
| `starttls` (default) | 587 | Plain connection, then `STARTTLS`. If the relay does not offer it, or the upgrade fails, **nothing is sent**: there is no fallback to plaintext. |
| `tls` | 465 | TLS from the first byte. |
| `plaintext` | 25 | No TLS. Allowed only when the relay's address is loopback, private (RFC 1918) or IPv6 unique-local, and only without `SMTP_USER`, so a password never crosses the network in clear. The server logs a warning at every start. |

The relay's certificate is always verified against the name in `SMTP_HOST`, at TLS 1.2 or later.
There is no setting that turns verification off. For a relay whose certificate comes from a private CA,
add the CA to `NODE_EXTRA_CA_CERTS`, as for Postgres ([configuration.md](configuration.md)). A
mode and a port that do not usually belong together (`starttls` on 465, `tls` on 25 or 587) log a
warning at start.

AUTH uses PLAIN, or LOGIN when only that is offered, and only after TLS is up. OAuth (XOAUTH2) is
not supported.

## Examples

### Amazon SES

```
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=<the SMTP user name SES created>
SMTP_PASSWORD=<its SMTP password — in the Secret>
SMTP_FROM=Acme Analytics <bi@acme.com>
```

`SMTP_FROM`'s address must be a verified identity in SES. While the SES account is in the sandbox, every
recipient must be verified too. SES takes at most 50 recipients per message. Ordinate sends larger
lists as several messages of 50.

### Office 365 / Exchange Online

Microsoft is retiring basic-auth SMTP AUTH in Exchange Online, and Ordinate does not speak OAuth to
SMTP. Use a **connector** (SMTP relay) instead: no password, the tenant trusts your egress IP.

```
SMTP_HOST=<tenant>.mail.protection.outlook.com
SMTP_PORT=25
SMTP_SECURITY=starttls
SMTP_FROM=Acme Analytics <bi@acme.com>
```

In the Exchange admin center, add an inbound connector from *your organization's email server* that
accepts mail from the public IP your pods leave through (a NAT gateway's address). `SMTP_FROM` must
be in one of your accepted domains. Google Cloud blocks outbound port 25 entirely, and AWS limits it
until you ask for it to be lifted. There, use SES or an internal relay.

### An internal Postfix relay

```
SMTP_HOST=smtp-relay.mail.svc.cluster.local
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_FROM=Acme Analytics <bi@acme.com>
```

With no TLS on the relay, set `SMTP_SECURITY=plaintext` and `SMTP_PORT=25`. That needs the relay
on a private address, and the server warns at every start.

### Helm

```yaml
config:
  SMTP_HOST: email-smtp.us-east-1.amazonaws.com
  SMTP_FROM: "Acme Analytics <bi@acme.com>"
  SMTP_USER: AKIA…
```

Add `SMTP_PASSWORD` as a key of your `existingSecret`. The chart refuses it in `config`. With
`networkPolicy.enabled`, add an egress rule for the relay:

```yaml
networkPolicy:
  egress:
    - to: [{ ipBlock: { cidr: 0.0.0.0/0, except: [169.254.169.254/32] } }]
      ports: [{ port: 587, protocol: TCP }]
```

## Who receives an email

At **each send**, an email list resolves to the people who are all of these:

- an account of this organization that is **not turned off** and **has signed in at least once**. An
  invited person who has not signed in yet gets nothing until they do;
- named on the list directly, or a member of a team the list names;
- able to **read the dashboard's project** right now: an org admin, or someone with a role on the
  project directly or through a team;
- at an address sign-in would accept (`ALLOWED_EMAIL_DOMAINS`, when it is set).

Someone who loses access before the next send stops receiving it. Anyone added to a team on the list
starts. A list nobody on which can read the project sends nothing, and the run says so. The figures
are computed as the subscription's owner, exactly as for Slack and Teams.

**Send a test email** (Admin → Channels) goes **only to the admin who clicks it**, with no data in
it. It says how many people on the list have signed in.

## Limits

- `RATE_LIMIT_EMAIL_ORG_PER_HOUR` (default 1000): recipients per organization per hour, counted across
  every pod (with `DATABASE_URL`). The hour starts at the first email of the hour, not a rolling
  hour, so right at its end up to twice the limit can go out within a few minutes.
  Subscriptions and alerts are counted separately, so a busy subscription schedule cannot stop an
  alert. **One project may use at most half of it** per hour, so one project cannot use up the
  organization's email. A list larger than that half can never go out, and its run says so ("this
  list is larger than the organization's hourly email limit"); raise the setting or split the list.
- The budget is charged per message of up to 50 recipients, for the recipients the relay accepted. A
  message the relay refused costs nothing. If the budget runs out partway, the rest of the list waits
  for the next run, and the run says how many it reached. A run stopped only by the budget does not
  count toward pausing the subscription.
- Ten test emails per organization per hour.
- **Send now**: once a minute per subscription, across every pod.
- At most 4 SMTP sessions at once per pod. After 3 failed connections in a row, sends fail fast for
  a minute instead of waiting on a dead relay.
- A failure before the end of the message is retried twice (after 1 s and 4 s). Once the message
  has been handed over, nothing is retried: the relay may have queued it, and a retry would send it
  twice.
- Each message of up to 50 recipients is tried, even after an earlier one failed. A send that reached
  some of the list and not the rest is **sent**, and its run says "the mail server took only *n* of
  its *m* recipients"; it never counts toward pausing. A TLS, sign-in or refused-relay failure ends the
  send at once, because every message would fail the same way.

## What a failed send says

| The run says | Check |
|---|---|
| Not sent: email is not set up on this server. | `SMTP_HOST`, `SMTP_FROM`, `DATABASE_URL`. |
| Not sent to *list*: nobody on it can read this project. | The project's sharing, and who is on the list. |
| Not sent to *list*: this organization reached its email limit for this hour. | `RATE_LIMIT_EMAIL_ORG_PER_HOUR`. It clears within the hour. |
| Not sent to *list*: this list is larger than the organization's hourly email limit. | The list is larger than half of `RATE_LIMIT_EMAIL_ORG_PER_HOUR`, the most one project may send in an hour. |
| Sent to *list*, but the mail server took only *n* of its *m* recipients. | The log's `email not sent` lines say which message the relay refused and why. |
| Not delivered to *list*: the mail server's encryption could not be verified, so nothing was sent. | `SMTP_SECURITY` and the port, the relay's certificate, `NODE_EXTRA_CA_CERTS`. The log names the check that failed. |
| Not delivered to *list*: the mail server did not accept this server's sign-in. | `SMTP_USER` / `SMTP_PASSWORD`. |
| Not delivered to *list*: the mail server answered *code*. | The log line holds the relay's own words, for example a sender address it does not accept. |
| Not delivered: *list* could not be reached. | `SMTP_HOST`, the port, egress and NetworkPolicy. |

The relay's own words go to the **server log only**: a warning `email not sent` with the reply code
and text. The password and its base64 forms are cut out first, in case a relay echoes them. They
never appear in a run's history, in a browser or in the audit log, because a relay's reply can name a
recipient. Each message sent leaves an info line `email sent`, with how many recipients it had
and how many the relay refused, and no addresses. Each send is on the audit trail as
`subscription:send` or `alerts:post`, with the list's id.

## What leaves the server

The same figures as a Slack or Teams post, from the same message: the dashboard's KPIs and up to
10 rows of each chart, as text, shaped by the project's share policy. There is no attachment, no image
and no remote content. The email carries no logo, so nothing in it calls back to the server or
counts opens. It has a text part and an HTML part. Its only link is **Open in Ordinate**, and the
dashboard still needs a sign-in. An editor's note on a subscription reads "Note from" whoever last wrote it. The
last line says which list the reader is on and that an org admin manages it. The sender's name
(`SMTP_FROM`) appears above the title.

Alerts that fire on the server's schedule are emailed. An alert checked by hand ("Check now"), by MCP
or by a manual refresh reaches the inbox only, as it does for Slack and Teams.
