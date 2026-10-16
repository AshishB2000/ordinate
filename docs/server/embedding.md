# Embedding dashboards in another site

<sub>[← All operator docs](README.md)</sub>

A published dashboard can be shown inside another web page — an internal portal, or a
customer-facing app where each customer must see only their own rows — through an `<iframe>`
whose URL the host app's **backend** signs. Nobody signs in to Ordinate to see it, and no cookie is
involved (browsers block third-party cookies in iframes anyway). This page is for the team that
runs the server and the team that builds the host app. The design and its decisions are in
[`docs/embed/00-design.md`](../embed/00-design.md).

It is **off** until an organization admin turns it on.

## What the server needs

| Need | Why | Without it |
|---|---|---|
| `DATABASE_URL` | The switch and the allowed sites are a row of `org_settings`; every embed view is an audit row. | Admin → Embedding says the server cannot embed. |
| `ORDINATE_MASTER_KEY` | The signing secret is a credential, so it is stored only encrypted (the same envelope encryption as connection passwords). | No secret can be generated, so nothing can be embedded. |
| HTTPS | The allowed sites must be `https://` (or `http://localhost` while developing), and a browser compares the frame's ancestors by exact origin. | — |

Nothing else: no new port, no new host. `/embed/*` is served by the same pods on the same origin.

## Set it up

1. **Admin → Embedding → Generate secret.** The secret (`ord_embed_…`) is shown **once**. Put it in
   the host backend's secret store, e.g. as `ORDINATE_EMBED_SECRET`. Ordinate never shows it again.
2. **Allow the host site**: its exact origin, `https://portal.example.com` — scheme, host and port,
   no path. Add each origin that will frame a dashboard (production, staging…), up to 20.
3. **Turn on "Allow embedding".**
4. **Publish** the dashboard (Dashboards → Publish…). Then on that published link, **⋯ → Embed…**
   gives the dashboard's ids, a picker for the locked filters, and the signing code filled in.

**Preview embed** (in Admin → Embedding and in the Embed… dialog) signs a ten-minute link with the
org's secret and shows the real page — before embedding is turned on, too. A preview link opens
only inside Ordinate, in a same-origin frame; pasted anywhere else it is refused.

## Sign a link (the host backend)

A link is `https://<ordinate>/embed/<token>`, where the token is a JWT, HS256 only:

```
base64url({"alg":"HS256","typ":"JWT","kid":"<org id>"}) . base64url(<claims>) . base64url(HMAC-SHA256)
```

The HMAC key is the whole secret string. The org id (`kid`) is shown in Admin → Embedding.

| Claim | Required | Meaning |
|---|---|---|
| `pub` | yes | The published link's id (Dashboards → the link → Embed…). |
| `dash` | no | Which dashboard of the link; default: its first. |
| `exp` | yes | Expiry, Unix seconds, **at most 24 hours ahead**. Sign a fresh link per page view, 5–10 minutes is plenty. |
| `params` | no | Locked filters: `{ "customer_id": ["C-1042"] }` — a column and the value(s) it is held to. |
| `theme` | no | `"light"` or `"dark"`, over the dashboard's own theme. |
| `hide` | no | `["title"]`, `["filters"]` or both: leave the dashboard's title or filter bar out. |

**Any other claim refuses the link**, so a misspelt `params` can never show an unfiltered
dashboard. Admin → Embedding has the code in Node and Python, standard library only. In short (Node):

```js
const crypto = require('node:crypto');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = b64({ alg: 'HS256', typ: 'JWT', kid: 'acme' });
const body = b64({ pub, dash, params: { customer_id: [session.customerId] }, exp: Math.floor(Date.now() / 1000) + 600 });
const sig = crypto.createHmac('sha256', process.env.ORDINATE_EMBED_SECRET).update(head + '.' + body).digest('base64url');
const src = `https://bi.example.com/embed/${head}.${body}.${sig}`;
```

**Lock values come from your session, never from the browser.** The browser only ever sees a
signed link; if your page let a user pick the value that goes into `params`, they could pick
someone else's.

## What a locked filter guarantees

Each locked column becomes a filter on **every figure the page holds** — computed by the server
before the page is built: each chart, each KPI (including saved metrics), each statistics tile,
and the filter bar's own options. The rows outside the lock are never in the page, so nothing a
viewer does in the browser can widen it.

Where a tile cannot honour a lock, it is **refused, not drawn**: it says "Not available in this
embedded view". That happens for a tile over a dataset that has no such column, a chart whose labels
come from a related dataset or whose measure is a formula metric, and the Summary card (its facts
are about whole datasets). The Embed… dialog warns when a column you lock is missing from some tiles.

The page is built from the dashboard **as it was published**: a tile added after publishing is not
in any embed until you publish again. A link published before this feature existed asks to be
published again. Figures are computed when the page is asked for and cached for five minutes per
(link, locks, theme); Live datasets keep the public cache floor `LIVE_MIN_CACHE_AGE_PUBLIC_SEC`.
The filter bar of an embed carries at most 64 combinations.

## The browser's side

- Only `/embed/*` may be framed, and only by the allowed sites: its `Content-Security-Policy` ends
  with `frame-ancestors <your origins>`. Every other route keeps `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`.
- The embedded page makes **no requests at all** (`default-src 'none'`): every figure it can show is
  in it. There is no API a link could be replayed against.
- When the frame request carries a `Referer` from a site not on the list, it is refused.

## When it does not show

Inside the frame the page says why, once the signature checks out:

| The frame shows | Why | What to do |
|---|---|---|
| This embed link has expired | `exp` is past (60 s of clock skew allowed). | Sign a fresh link per page view; check the host's clock. |
| This embed link is valid for too long | `exp` more than 24 h ahead. | Sign shorter-lived links. |
| This embed link is not valid | A bad signature, another algorithm, an unknown claim, an empty lock, a rotated secret. | Check the secret and the claims. A bad signature is refused before the org is trusted, so that page cannot be framed: the frame is blank. |
| Embedding is not available | Embedding is off, or there is no secret. | Admin → Embedding. |
| This site is not allowed to show this dashboard | The `Referer` is not an allowed site. | Add the origin. |
| This dashboard is no longer published / Publish this dashboard again | The link was taken down, or predates kept definitions. | Publish again (the link's id stays). |
| A blank frame, and a console error naming `frame-ancestors` | The page that frames it is not an allowed site. | Add its exact origin. |

## Rotating the secret

**Admin → Embedding → Rotate…** makes a new secret and shows it once. Every link signed with the
old one stops working **at once**, on every pod — deploy the new secret to the host backend right
after. Turning embedding off stops every embed at once, too.

## Limits, audit, logs

- Views per token: `RATE_LIMIT_EMBED_PER_MINUTE` (120); per organization:
  `RATE_LIMIT_EMBED_ORG_PER_MINUTE` (1,200); per client IP: the RPC budget. All per pod. Over → `429`.
- Every view whose signature checks out is an audit row (Admin → Audit log → **Embed views**): the
  link and dashboard ids and the outcome, actor `embed`. Never the token.
- The token is masked in the request log (`/embed/[redacted]`); the secret is in no log line and in
  no reply but the one that created it.
