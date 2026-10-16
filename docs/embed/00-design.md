# Signed embedding — design

A published dashboard shown inside another site — an internal portal, or a customer-facing app
that shows each customer only their own rows — through an `<iframe>` whose URL the host app's
**backend** signs. Off until an org admin turns it on.

## What you will see when this is done

- **Admin → Embedding** (a new tab, next to Settings). A switch "Allow embedding", a list of the
  sites allowed to frame a dashboard (`https://portal.acme.com`, one exact origin per row; plain
  `http://` only for `localhost`), and the **signing secret**: "Generate secret" shows a
  `ord_embed_…` value **once**, in a dialog with Copy, then the page only says *Stored*, with
  *Rotate…* (which says that every embed already out there stops working). Below it, copy-paste
  code for the host's backend — **Node** and **Python**, standard library only — that signs a token,
  and **Preview embed**: pick a published dashboard, optionally a locked filter, and the page shows
  the real `/embed/…` iframe, signed by the server for ten minutes.
- **Dashboards** (the published-links list): each link's ⋯ menu gets **Embed…**. The dialog shows the
  embed URL pattern, the claims for that dashboard (`pub`, `dash`), a **locked-filter picker** — the
  columns every tile of the dashboard can be filtered on, a value or several for each — theme and
  "hide the title / the filter bar" switches, the token payload those choices make, the same Node and
  Python snippets filled in for it, and **Preview**. When embedding is off it says so (and, to an
  admin, links to Admin → Embedding).
- **In the host's page**: `<iframe src="https://bi.acme.com/embed/<token>">`. The dashboard renders
  as it does at `/p/…` — the same renderer, the same pinned CSP, zero requests from the page — with
  every figure computed **under the locked filters**. A locked customer sees only their own
  figures: their totals, their chart bars, their filter-bar options. Nothing in the page lets them
  remove or widen the filter, because the rows outside it never reached the page.
- A framing site **not** on the list gets a blank, blocked frame (the browser refuses it on the
  CSP `frame-ancestors`); an expired token shows "This embedded dashboard has expired" inside the
  frame; a bad signature shows a bare refusal that no one may frame.
- **Admin → Audit log** gains "Embed views": one row per view, the site and dashboard ids, the
  outcome — never the token.

## Decisions (the brainstorming questions, answered)

| Question | Decision | Why |
|---|---|---|
| Which model? | **Static signed embedding** (Metabase's model): the host backend holds a per-org HMAC secret and signs a short-lived token; no Ordinate account for the viewer. | Customer-facing analytics cannot give every customer an IdP account. Third-party cookies are blocked in iframes anyway. |
| Token format | JWT compact form, `HS256` only: `base64url(header).base64url(payload).base64url(HMAC-SHA256)`. Any JWT library on the host can produce it; the snippets need only the standard library. | Familiar, small, one algorithm. |
| Which org? | `header.kid` = the org id. The server looks up that org's secret; a token signed for org A and claiming org B fails B's signature. | No scan over orgs; no org secret is ever tried that the token did not name. |
| Claims | `pub` (published link id, required), `dash` (dashboard id; default: the link's first dashboard), `exp` (required, ≤ now + 24 h), `iat` (optional), `params` (locked filters: `{ "<column>": value \| [values] }`), `theme` (`light`\|`dark`), `hide` (`["title", "filters"]`). **Any other claim refuses the token.** | A typo (`parmas`) must never silently produce an **unscoped** dashboard. |
| Verification order | length/shape → header exactly `{alg:'HS256', typ?:'JWT', kid}` (`none`, `HS512`, `RS256`, a missing alg: refused before any key is read) → org has a secret → `timingSafeEqual` on the 32-byte MAC → only then the payload is parsed → claims → `exp` → embedding on → the link exists in that org and names `dash` → build. | Nothing from an unauthenticated payload is used before the MAC holds. |
| Where are settings? | `org_settings.embed_enabled` and `embed_origins text[]` (migration **0017**, additive), beside `public_links`. The secret: the secrets store, kind `embed.signing`, ref `org` (envelope encryption under `ORDINATE_MASTER_KEY`). No DB or no master key → Admin says the server cannot keep a secret, and generating one is refused. | The embed route reads them by org id before any request context exists; the public-links precedent. 0017 also widens the audit action CHECK with `embed_view`. |
| Secret format | `ord_embed_` + 43 base64url chars (32 random bytes). The HMAC key is the whole string, UTF-8. Shown once (the `embed:rotate` reply), never readable again. | One string to paste into the host's env; nothing to decode. |
| Rotation | Generating a new secret replaces the old: every token signed with the old one fails at once. No overlap window. | The brief: rotation invalidates all tokens. An overlap is a ponytail upgrade (store two, accept either for N minutes). |
| Allowed origins | Exact origins only, as `URL.origin` normalises them: `https` (any host) or `http` for `localhost`, `127.0.0.1`, `[::1]`; no path, query, wildcard, userinfo; ≤ 20 entries. | `frame-ancestors` needs exact sources; a wildcard is how an allow-list stops meaning anything. |
| Which routes may be framed? | Only `/embed/*`, with `frame-ancestors <the org's origins>` and no `X-Frame-Options`. Every other route keeps `frame-ancestors 'none'` and `X-Frame-Options: DENY`. A refusal page after the MAC holds (expired, unpublished) is framable by the same origins so the host sees why; one before (bad signature) is not. | Embedding is the exception, decided per org, not a global loosening. |
| Referer check | When the iframe request carries a `Referer` whose origin is neither this server's nor an allowed one → 403. Absent Referer (a `no-referrer` host) is allowed: `frame-ancestors` is the browser-enforced control. | Defence in depth, cheap. |
| What does the page show? | The **published definition**: at publish time the server now also stores each dashboard's record and the visuals it references (`<publishId>/defs.json`). An embed is built from that definition, not from the editable dashboard, so a tile added after publishing is never embedded. A link published before this change has no definition: "Publish this dashboard again to embed it". Saved metrics referenced by id resolve as they are now. | Customer-facing pages must not show draft tiles. |
| Snapshot or live figures? | Built **on demand** under the locked filters (no other way: every customer's figures cannot be precomputed), cached 5 minutes per (org, link, publish time, dashboard, locks, theme, hide) and shared by concurrent identical views. | The `/p/` page is a snapshot; an embed is "the published dashboard, now, for this customer". Documented on the operator page. |
| Filter-bar size | At most **64** combinations (the link's own setting when lower). | Every combination is computed per view (cache miss); 256 per customer is too slow cold. |
| Locks in the data path | Each locked column becomes a filter step (`=` for one value, `in` for several) with `context: true` (before LOD expressions), placed **first** in every tile's filter list, on every figure path the page uses: charts (`vizDataFor`), KPIs (`resolveMetric` / `computeCardMetric`), statistics tiles, the Summary card, and the filter bar's options. | The rows outside the lock never reach a figure, so no client trick reaches them. |
| A tile whose dataset lacks a locked column | **Fails closed**: the tile says "Not available in this embedded view" (the pipeline would otherwise *skip* an unknown-column filter and draw the unscoped figure). Same for a KPI over a saved metric whose dataset lacks it, a Summary card when any dataset on the dashboard lacks it. | The one silent-widening path in the engine is closed at the door. |
| Filter-bar options under a lock | A control on a locked column offers only the locked values. A text dropdown on another column offers the values that exist **under the lock** (`vizDataFor`, count by that column — no other customer's value is listed); a number/date dropdown, a dropdown over a Live dataset (its options are a sample), or a control over a dataset lacking a locked column is left out of the bar. Date-range, radius and parameter controls are unchanged (they only narrow). | A filter option is data too. |
| Values in a lock | 1–100 values per column, each a string ≤ 200 chars or a finite number; ≤ 8 columns; an empty list refuses (an empty `in` skips — it would widen). | Bounded; nothing that widens. |
| Cookies, RPC | None. The embed page makes **zero** requests (its CSP is `default-src 'none'`): every combination it can show is in the page. So there is no API surface for a token to be replayed against. | Strictly narrower than "RPCs carry the token". |
| Preview | `embed:preview` (project **write**, i.e. who may publish) signs a 10-minute token with `prv: 1` and the org's secret, whether or not embedding is on. A preview token is served only to a same-origin iframe (`Sec-Fetch-Dest: iframe` and `Sec-Fetch-Site: same-origin`), with `frame-ancestors 'self'`. | An editor can check an embed before an admin turns it on, without being able to hand an outsider a working link. |
| Live datasets | Built under `runAsPublished`, so the `/p/` floor `LIVE_MIN_CACHE_AGE_PUBLIC_SEC` holds, plus the daily limit, plus the 5-minute page cache. | A busy customer portal must not be a warehouse poll. |
| Rate limits | Per IP (the RPC per-IP budget, before any DB query), per token (`RATE_LIMIT_EMBED_PER_MINUTE`, 120) and per org (`RATE_LIMIT_EMBED_ORG_PER_MINUTE`, 1,200), per pod (R8). Over → 429 page. | |
| Audit | `audit_log.action = 'embed_view'`, actor `embed`, targets = link and dashboard ids, outcome ok / denied / error, for every request whose MAC held. A request whose MAC failed names no trustworthy org and is not audited (it is counted on `/metrics`). | |
| Logs | The token is masked in the request log (`/embed/<masked>`) and in Fastify's own messages. The secret is in no reply but the one that creates it, never in a log line (canary test). | |

## Token reference

```json
// header
{ "alg": "HS256", "typ": "JWT", "kid": "<org id>" }
// payload
{
  "pub": "1f0c…-…",                       // published link id (Dashboards → the link)
  "dash": "8a2e…-…",                      // optional: which dashboard of the link
  "exp": 1760000000,                      // required, seconds; at most 24 h ahead
  "params": { "Customer": "Acme", "Region": ["East", "West"] },
  "theme": "dark",                        // optional
  "hide": ["title", "filters"]            // optional
}
```

Refusals (the page text inside the frame, and the HTTP status): malformed / bad signature / wrong
algorithm → 403 "This embed link is not valid"; expired → 403 "has expired"; `exp` too far ahead →
403; embedding off → 403 "Embedding is not available"; the link or dashboard gone, or published
before definitions were kept → 404; a widened or unknown claim → 403; rate → 429.

## Files

| File | Job |
|---|---|
| `src/server/embed/token.ts` | sign / verify (pure) |
| `src/server/embed/settings.ts` | org settings, origins validation, the secret |
| `src/server/embed/route.ts` | `GET /embed/:token`: verify, limit, headers, audit, serve |
| `src/server/embed/pages.ts` | refusal pages (through `t()`) |
| `src/publish/embedPage.ts` | build one dashboard page from the published definition under locks (cache, single-flight) |
| `src/publish/embedLock.ts` | locks → filter steps, per-tile fail-closed check, filter-bar options under a lock |
| `src/ipc/embed.ts` + `src/api/embed.ts` | `embed:settings`, `embed:save`, `embed:rotate`, `embed:status`, `embed:columns`, `embed:preview` |
| `web/src/features/admin/EmbeddingTab.tsx` | Admin → Embedding |
| `web/src/features/dashboards/EmbedDialog.tsx` | the link's Embed… dialog |
| `web/src/features/embed/snippets.ts` | the Node and Python signing snippets |

## Tests

- `scripts/test-embedToken.ts` — sign/verify: round trip; expired; `exp` > 24 h; missing `exp`;
  bad signature (one bit); `alg: none`, `HS512`, `RS256`, missing alg; wrong `kid` (signed for A,
  claims B); unknown claim; empty lock list; oversize token. Negative control: a correct token
  verifies.
- `scripts/test-embed-db.ts` (Postgres) — the route end to end: embedding off; no secret;
  unpublished link; a dashboard not in the link; a link of another org; rotation kills old tokens;
  CSP per route (`/embed/*` gets the org's origins, `/`, `/p/`, `/api/` keep `'none'` and XFO);
  the Referer check; preview tokens refused top-level; the audit row; rate limit → 429; the
  secret canary over every reply, the log, the page and the audit table.
- `scripts/test-embedLock.ts` — locked filters on every figure path, **differential**: each tile of
  an embed with `Region = East` equals (`Object.is`, via the payloads) the tile of the same dashboard
  with `Region = East` added to its own filters; the filter-bar options are East's only; a tile over
  a dataset without `Region` is refused, not drawn (negative control: unlocked, it draws); a token
  with the lock removed or widened (`[East, West]` re-signed with another key, or the payload edited)
  is refused; nothing of West appears anywhere in the page.
- `web/src/features/admin/embedding.test.tsx` — the Admin tab: states, origin validation, the
  once-only secret, rotate confirm.
- `web/e2e/embed.e2e.ts` — a parent page on a second local origin frames `/embed/<token>` and the
  dashboard renders inside it (zero CSP violations in the frame); the same page on an origin not on
  the list is blocked by `frame-ancestors`; Admin → Embedding and the Embed dialog screenshots.
