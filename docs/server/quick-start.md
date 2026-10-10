# Quick start: Docker Compose

<sub>[← All operator docs](README.md)</sub>

This runs Ordinate for one team on one host: the server, Postgres 17 (users, records, jobs,
secrets) and MinIO (the Parquet tables, over the S3 API), from `deploy/docker-compose.yml`. Postgres
and MinIO publish no ports. The app port is published on `127.0.0.1` only.

You need Docker with Compose v2, about 2 GB of free disk and a free port 8080 on `127.0.0.1`. The
stack runs on linux/amd64 and linux/arm64 alike.

## 1. Configure

From a checkout of the repository:

```bash
cd deploy
cp .env.example .env
cat >> .env <<EOF
ORDINATE_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
EOF
```

`.env.example` leaves those three empty. The heredoc appends generated values, and for a repeated
key Compose uses the last line. Nothing else is needed to try it: the stack starts with password
sign-in, and you create the admin account in the browser (step 3).

**Keep a copy of `ORDINATE_MASTER_KEY`.** Every stored connection password and AI key is encrypted
under it. Without it they cannot be read, even from a good database backup.

## 2. Start

```bash
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8080/readyz
```

`--build` builds the image from this checkout. To run a released image instead, set
`ORDINATE_IMAGE=ghcr.io/ashishb2000/ordinate:<version>` in `.env` and start with
`docker compose up -d --no-build`, which pulls the image if it is not already local.

`/readyz` answers `{"ok":true,"checks":{"duckdb":true,"postgres":true}}` once the server has
migrated the database and DuckDB has loaded its S3 extensions. Those extensions are baked into the
image, and the container downloads nothing at run time.

Measured on an Apple-silicon laptop (Docker 29.8, T7.3) from a clean state: no `ordinate_*`
containers, volumes or networks, and no `.env`:

| Step | Time |
|---|---|
| `docker compose up -d --build`, most image layers cached | 38 s |
| until `/readyz` answered ok | 1 s more |
| swapping to a prebuilt image (`ORDINATE_IMAGE` + `up -d --no-build`) until ok | 2 s |

A first build with nothing cached adds a few minutes. T7.1 measured `up --wait` at 54 s with a cold
build on the same machine.

## 3. Sign in

The stack starts with `AUTH_MODE=password`: Ordinate's own accounts, for trying it out. At its
first start the server prints a one-time setup code:

```bash
docker compose logs ordinate | grep "setup code"
```

Open `http://127.0.0.1:8080` on this machine. The sign-in page shows **Create the admin account**:
enter the code, your email and a password. You land in Ordinate as the org admin. Add everyone
else in **Admin → People → Add person** with a temporary password, which they replace at their
first sign-in. The code lasts 24 hours, and `docker compose restart ordinate` prints a new one.

Over plain `http` the sign-in cookies (`Secure`, since the stack runs `ORDINATE_ENV=prod`) are only
accepted from `127.0.0.1`. To sign in from other machines, put TLS in front. The server logs a
warning at every start that password sign-in is not for real use. Before real use, switch to single
sign-on. Pick one:

- **OIDC directly** (recommended). Set `AUTH_MODE=oidc`, the four `OIDC_*` values and
  `ORDINATE_ADMIN_EMAIL` in `.env`, and put a TLS proxy in front: prod cookies are `Secure`, and
  the redirect URL must be `https://`. See [sso.md](sso.md).
- **oauth2-proxy in front** (header mode). Set `AUTH_MODE=header` and `ORDINATE_ADMIN_EMAIL`, run
  oauth2-proxy on this host with your IdP, upstream `http://127.0.0.1:8080`, and terminate TLS in
  front of it. The flags are in `.env.example` and
  [sso.md](sso.md#header-mode-behind-oauth2-proxy).

People keep their roles when they move over: accounts are matched by email. See
[sso.md](sso.md#password-sign-in-for-trying-ordinate-out).

In header mode, Ordinate trusts the `X-Forwarded-Email` header from whatever connects through the
published port. To check that the server sees an identity:

```bash
curl -s -H 'X-Forwarded-Email: admin@example.com' http://127.0.0.1:8080/api/auth/me
```

That command should print `"role":"admin"` for the address in `ORDINATE_ADMIN_EMAIL`. Anyone who
can reach the port can claim any address the same way. That is why the port is bound to
`127.0.0.1`. **Never set `ORDINATE_BIND=0.0.0.0` in header mode.**

After changing `.env`, apply it with:

```bash
docker compose up -d
```

## 4. Day two

| Task | Command |
|---|---|
| Logs | `docker compose logs ordinate` |
| Stop (data kept in the named volumes) | `docker compose down` |
| Delete everything, data included | `docker compose down -v` |
| Prometheus metrics | scrape `ordinate:9464` from the Compose network. It is not published on the host, and the app port answers 404 for `/metrics`. |
| Back up | [backup-restore.md](backup-restore.md) |
| Upgrade | [upgrade.md](upgrade.md) |

## Troubleshooting

- **`Pool overlaps with other one on this host`.** Another network already uses `172.30.80.0/24`.
  Set `ORDINATE_SUBNET` to a free `/24`, and set `TRUSTED_PROXY_CIDRS` to that subnet's `.1`.
  Change both together. Connections through the published port arrive from that gateway address,
  so in header mode a mismatch leaves every request signed out.
- **Port 8080 is taken.** Set `ORDINATE_PORT` in `.env`.
- **No setup code in the log.** An admin with a password already exists (setup is done), or the
  code is older than 24 hours: `docker compose restart ordinate` prints a fresh one while no admin
  has a password.
- **Signed in, then straight back to the sign-in page.** The browser refused the `Secure` cookies
  over plain `http`. Open `http://127.0.0.1:8080` on the Docker host itself, or put TLS in front.
- **The `ordinate` container restarts in a loop.** `docker compose logs ordinate` shows one line
  starting `ordinate:` that names the bad variable, for example
  `ordinate: ORDINATE_MASTER_KEY must be 32 bytes written as base64 (44 chars) or hex (64 chars) (value not shown)`.
- **Passwords with symbols break `DATABASE_URL`.** The passwords go into URLs. Use letters, digits,
  `-` and `_` only, which `openssl rand -hex` guarantees.
