# Single sign-on

Ordinate signs people in with single sign-on, one of two ways (`AUTH_MODE`):

- **`oidc`**: Ordinate itself is the OpenID Connect client of your IdP. This is the recommended
  mode for Kubernetes and ECS.
- **`header`**: a proxy in front of Ordinate (oauth2-proxy) signs people in, and Ordinate believes
  the proxy's `X-Forwarded-Email`.

Until you set one, a server runs **`password`** sign-in: Ordinate's own accounts, for trying it
out. See [Password sign-in](#password-sign-in-for-trying-ordinate-out) for how it works and how to
move off it.

In both SSO modes, the identity is the **email address**, lower-cased. The first time an address signs
in, it joins the deployment's org (`ORDINATE_ORG`) as a **viewer**. `ORDINATE_ADMIN_EMAIL` is made
admin at every sign-in, and admins grant roles in Admin. `ALLOWED_EMAIL_DOMAINS` refuses every other
domain. A disabled user is refused, and their sessions are deleted. Personal API tokens
(`Authorization: Bearer ord_…`) work in both modes.

Everything below about Ordinate's side is read from `src/server/auth/` and `src/server/env.ts`. The
OIDC flow is tested end to end against a mock IdP that checks PKCE and the client secret
(`web/e2e/auth.e2e.ts`, `scripts/mockOidc.ts`). The per-IdP steps follow each vendor's console and
have not each been run against a live tenant.

## What Ordinate needs from any OIDC IdP

| Setting | Value |
|---|---|
| Application type | Web application with a client secret (a confidential client), authorization code flow. Implicit and hybrid flows are not needed. |
| Redirect (callback) URI | `https://<your host>/api/auth/callback`, exactly. The same string goes in `OIDC_REDIRECT_URL`. |
| Scopes requested | `openid email profile` |
| Claims used | `email` (required) and `email_verified`. If `email_verified` is present and `false`, sign-in is refused. If it is absent, sign-in is accepted. |
| PKCE | S256, always sent. IdPs that require PKCE for confidential clients are fine. |
| Token endpoint authentication | `client_secret_post`: the secret goes in the form body. If the IdP enforces a method per client, choose POST. |
| Sign-out URL | None. Sign-out ends the Ordinate session only, not the IdP session. |

Ordinate's settings ([configuration.md](configuration.md#sign-in)):

```
AUTH_MODE=oidc
OIDC_ISSUER=https://idp.example.com/realms/acme
OIDC_CLIENT_ID=ordinate
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URL=https://ordinate.example.com/api/auth/callback
```

(These lines are from `deploy/.env.example`.) `OIDC_CLIENT_SECRET` is a secret. In Kubernetes it
goes in the chart's `existingSecret`, in ECS in a `secrets` entry, never in values. `OIDC_ISSUER`
must be the `issuer` field of the IdP's `/.well-known/openid-configuration`, character for
character, including a trailing slash if the IdP has one. A mismatch fails discovery.

### How a sign-in runs

1. `GET /api/auth/login` builds the authorization URL. The state, nonce and PKCE verifier ride in a
   10-minute httpOnly cookie scoped to `/api/auth/callback`. Nothing is stored server-side, so any
   pod can finish any login.
2. The IdP redirects to `/api/auth/callback`. Ordinate exchanges the code and verifies the ID
   token: signature against the IdP's JWKS, `iss`, `aud`, `exp` with 30 s clock tolerance, and the
   nonce. It then issues a new session cookie.
3. The IdP's discovery document is fetched at the first sign-in and cached. If the IdP is down
   then, the next sign-in retries. A pod never fails to start because the IdP is unreachable.

A failed sign-in lands on `/sign-in?error=<code>`. The pod logs one `warn` line with the error's
name and code, never a token:

| Code | Meaning |
|---|---|
| `unavailable` | Discovery failed. The issuer URL is wrong, or the pod cannot reach the IdP (egress rules, NetworkPolicy). The SSRF guard does not apply to the IdP, so an internal IdP needs no `SSRF_ALLOW`. |
| `expired` | The 10-minute login cookie was missing. The user took too long, or a proxy dropped the cookie. |
| `denied` | The IdP answered `access_denied`, for example because the user is not assigned to the app. |
| `failed` | The code exchange or token check failed. Check the client secret, the redirect URI, the token endpoint method and the server clock. |
| `email` | The ID token carried no email, or `email_verified: false`. |
| `domain` | The domain is not in `ALLOWED_EMAIL_DOMAINS`. |
| `disabled` | An admin disabled this user. |

## Okta

1. **Applications → Create App Integration → OIDC – OpenID Connect → Web Application.**
2. Set the sign-in redirect URI to `https://<host>/api/auth/callback`, and the grant type to
   authorization code.
3. Assign the people or groups who may use Ordinate.
4. Set `OIDC_ISSUER` to an authorization server: `https://<your-org>.okta.com/oauth2/default` for
   the default custom one, or `https://<your-org>.okta.com` for the org server. Okta includes `email`
   and `email_verified` in the ID token when the `email` scope is requested.
5. If sign-in fails with `failed` and the log shows `invalid_client`, set the app's client
   authentication method to client secret **POST**.

## Microsoft Entra ID (Azure AD)

1. **App registrations → New registration.** Use a single tenant, platform **Web**, and redirect URI
   `https://<host>/api/auth/callback`.
2. Under **Certificates & secrets**, create a client secret. Under **Token configuration**, add the
   optional claim `email` to the ID token. Without it, an Entra ID token may carry no `email`, and
   sign-in fails with `email`.
3. Set `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0` and `OIDC_CLIENT_ID` to the
   application (client) ID. Use your tenant ID. The multi-tenant `common` and `organizations`
   endpoints were not tested, and a deployment has one org anyway.
4. Entra ID sends no `email_verified`, so Ordinate accepts the `email` claim as Entra ID gives it.
   Set `ALLOWED_EMAIL_DOMAINS` to your verified domains, and use **Enterprise applications →
   Properties → Assignment required** to choose who may sign in.

## Google (Workspace)

1. In the Google Cloud console, open **APIs & Services → OAuth consent screen** and choose
   **Internal**. Only your Workspace accounts can sign in. With **External**, any Google account can
   pass the IdP, and `ALLOWED_EMAIL_DOMAINS` becomes the only fence.
2. Under **Credentials → Create credentials → OAuth client ID**, choose **Web application**, with
   authorized redirect URI `https://<host>/api/auth/callback`.
3. Set `OIDC_ISSUER=https://accounts.google.com`. Google sends `email` and `email_verified`. Set
   `ALLOWED_EMAIL_DOMAINS` to your domain anyway.

## Keycloak

1. In your realm, go to **Clients → Create client**, type **OpenID Connect**. Turn **Client
   authentication** on (a confidential client) and **Standard flow** on.
2. Set **Valid redirect URIs** to `https://<host>/api/auth/callback`. Copy the secret from the
   **Credentials** tab.
3. Set `OIDC_ISSUER=https://<keycloak host>/realms/<realm>`. Keycloak before version 17 used
   `/auth/realms/<realm>`; copy whatever your discovery document says.
4. Keycloak sends `email_verified`. Users whose address is not verified are refused with `email`.
   Mark their addresses verified, or turn on the realm's **Verify email**.

## Auth0

1. **Applications → Create Application → Regular Web Applications.**
2. Set **Allowed Callback URLs** to `https://<host>/api/auth/callback`.
3. Set the application's token endpoint authentication method to **Client Secret (Post)**.
4. Set `OIDC_ISSUER=https://<tenant>.<region>.auth0.com/`. Auth0's issuer ends in a slash; a custom
   domain's issuer is that domain. Auth0 sends `email_verified`, so database and social users with
   unverified addresses are refused with `email`.

## Header mode behind oauth2-proxy

In `header` mode, Ordinate believes `X-Forwarded-Email` **only** when the TCP peer of the connection
(the socket address, never `X-Forwarded-For`) is inside `TRUSTED_PROXY_CIDRS`. Any other peer
gets `user: null`, and its requests are refused. `TRUSTED_PROXY_CIDRS` is required in this mode, and
a forged header from an untrusted peer is covered by `test-auth-db`. Ordinate has no sign-out button
in this mode. People sign out at the proxy, oauth2-proxy's `/oauth2/sign_out`. Sign-ins leave no
audit row, because the proxy has none to hand over (threat model R11).

oauth2-proxy, as `deploy/.env.example` runs it in front of the Compose stack:

```
oauth2-proxy --provider=oidc --oidc-issuer-url=https://idp.example.com \
  --client-id=… --client-secret=… --cookie-secret=… --email-domain=example.com \
  --upstream=http://127.0.0.1:8080 --pass-user-headers=true --set-xauthrequest=true \
  --http-address=0.0.0.0:4180 --redirect-url=https://ordinate.example.com/oauth2/callback
```

Register `https://<host>/oauth2/callback`, which is the proxy's callback, not Ordinate's, at the
IdP, and put TLS in front of the proxy. With Compose, the app port stays on `127.0.0.1`, and the
default `TRUSTED_PROXY_CIDRS=172.30.80.1/32` is the Compose network's gateway: whatever connects
from this host. See [quick-start.md](quick-start.md#3-sign-in).

**On Kubernetes, the proxy's address is a pod IP**, so `TRUSTED_PROXY_CIDRS` ends up naming a pod
range. Every other pod in that range could then claim any email by connecting to Ordinate's Service
directly. Header mode on Kubernetes is safe only when nothing but the proxy can reach the app port:

```yaml
config:
  AUTH_MODE: header
  TRUSTED_PROXY_CIDRS: "10.244.0.0/16"   # your pod CIDR
ingress:
  enabled: false                          # the Ingress routes to oauth2-proxy instead
networkPolicy:
  enabled: true
  ingressFrom:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: oauth2-proxy
```

This needs a CNI that enforces NetworkPolicy. The chart's NetworkPolicy was proven on kind with
kindnet (T7.2). Prefer `oidc` mode there: it has no proxy to trust.

## Password sign-in (for trying Ordinate out)

`AUTH_MODE=password` is the default, so a server nobody has configured yet asks for a password
instead of letting anyone in. It needs Postgres (`DATABASE_URL`). At every start the server logs a
warning that this mode is for trying Ordinate out. Move to `oidc` or `header` before real use:
password sign-in has no MFA, and leavers have to be disabled in Ordinate by hand.

**First admin.** While no enabled admin has a password, each pod logs a one-time setup code at
startup, for example `First-run setup code: K7QM-2XRA-V9TD`. Only its sha256 is stored. The sign-in
page then shows **Create admin account**, which asks for the code, an email and a password.

```bash
docker compose logs ordinate | grep "setup code"      # Compose
kubectl logs deploy/<release>-ordinate | grep "setup code"   # Kubernetes
```

A code works on any pod, lasts 24 hours, and stops working once the admin exists. Restart the
server to print a fresh one. Whoever can read the server's log can create the first admin, which is
why the log is the channel.

**Everyone else.** An admin adds people in **Admin → People → Add person** with a temporary
password (**Generate** makes a random 16-character one). The admin hands it over themselves, since
Ordinate sends no email. At the first sign-in the person has to choose their own password: until
then every page goes to `/change-password` and every API call except `/api/auth/*` answers 403. A
forgotten password is the same flow, through **Reset password** in the person's row menu. A reset
also signs them out everywhere.

**What the server enforces:**

| Rule | Detail |
|---|---|
| Storage | scrypt (N=2^15, r=8, p=1, 16-byte salt), from Node's own `crypto`. A password is never stored, logged or audited. |
| Length | 10 to 256 characters. |
| Wrong passwords | A wrong email and a wrong password get the same answer. After 10 wrong passwords in 15 minutes, the account is locked until the window ends (per pod). `RATE_LIMIT_LOGIN_PER_MINUTE` also covers the password routes, per client IP. |
| Changing a password | Asks for the current one, and signs out every other session of the account. |
| Sessions | The same session cookie as `oidc`, rotated at every sign-in, under `SESSION_IDLE_MINUTES` and `SESSION_ABSOLUTE_HOURS`. |
| Audit | Sign-ins (`login`), password changes (`password_change`), and the admin's `admin:addUser` / `admin:resetPassword` calls. |

Over plain `http`, prod's `Secure` cookies are only accepted from `127.0.0.1` and `localhost` (tested
in Chromium). To sign in from another machine, put TLS in front, as for SSO.

**Moving to SSO.** Set `AUTH_MODE=oidc` (or `header`) and its variables, then restart. Accounts are
matched by email, so people keep their roles, teams and project grants when they first sign in
through the IdP. The stored password hashes are no longer used. Set `ORDINATE_ADMIN_EMAIL` so an
admin exists from the first SSO sign-in.

`AUTH_MODE=dev`, which signs every request in as an admin and needs no Postgres, is only for
Ordinate's own automated tests. It is never the default, and `ORDINATE_ENV=prod` refuses it.
