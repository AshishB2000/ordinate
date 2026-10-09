# Warehouses and live data

This page is for the team that connects Ordinate to a cloud warehouse. It covers what each warehouse
needs on its side (a read-only identity) and on yours (network egress). The plan behind it is
[docs/live-data/00-plan.md](../live-data/00-plan.md). Sections for BigQuery, cost limits, cache ages
and the refresh URL are added by the tasks that build them.

## Snowflake

Ordinate talks to Snowflake over its **SQL API** (HTTPS and JSON, no driver). A connection needs an
account identifier, a user, a warehouse, a role, and one of two credentials:

- **Key pair** (recommended): the user's RSA private key, PEM, PKCS#8, encrypted or not, plus its
  passphrase when encrypted. Ordinate signs a short-lived token (a `KEYPAIR_JWT`, valid at most one
  hour) with it for each connection; the private key itself is never sent anywhere.
- **Programmatic access token** (PAT): sent as the bearer token.

Ordinate does not offer password-only sign-in, which Snowflake is retiring. Both credentials are
stored in the encrypted secrets store (`ORDINATE_MASTER_KEY` and `DATABASE_URL`). The key goes in the
connection's `token` slot and its passphrase in `password`. Neither is ever sent to a browser: the
connection form shows "Key saved", and **Replace** takes a new key, tests it, and keeps it only if
the test passes.

### Read-only is your role's job

Snowflake's SQL API has no read-only session. **Ordinate never writes**, but the guard against a
write is the role the connection signs in with. **Test connection** warns when that role is
`ACCOUNTADMIN`, `SYSADMIN` or `SECURITYADMIN`. It does not see a custom role that has been granted
one of those, so keep the grants below as they are.

A read-only role, a warehouse for it, and a service user that can only sign in with a key pair:

```sql
USE ROLE SECURITYADMIN;

CREATE ROLE IF NOT EXISTS ORDINATE_READER COMMENT = 'Ordinate: read-only';

-- Run queries on one warehouse (a small, dedicated one keeps the bill readable).
GRANT USAGE ON WAREHOUSE ORDINATE_WH TO ROLE ORDINATE_READER;

-- Read one database: existing and future schemas, tables and views.
GRANT USAGE ON DATABASE SALES TO ROLE ORDINATE_READER;
GRANT USAGE ON ALL SCHEMAS IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT SELECT ON ALL TABLES IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT SELECT ON FUTURE TABLES IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT SELECT ON ALL VIEWS IN DATABASE SALES TO ROLE ORDINATE_READER;
GRANT SELECT ON FUTURE VIEWS IN DATABASE SALES TO ROLE ORDINATE_READER;

-- A service user: no password, key-pair sign-in only.
USE ROLE USERADMIN;
CREATE USER IF NOT EXISTS ORDINATE_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = ORDINATE_READER
  DEFAULT_WAREHOUSE = ORDINATE_WH;

USE ROLE SECURITYADMIN;
GRANT ROLE ORDINATE_READER TO USER ORDINATE_SVC;
```

Grant nothing else to `ORDINATE_READER`: no `OWNERSHIP`, no `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`, no
`CREATE` on a schema, and no other role.

### The key pair

Generate an encrypted key (you are asked for its passphrase) and its public half:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -v2 aes-256-cbc -inform PEM -out ordinate_svc.p8
openssl rsa -in ordinate_svc.p8 -pubout -out ordinate_svc.pub
```

Give Snowflake the public key: the body of `ordinate_svc.pub`, without its `-----BEGIN/END-----`
lines.

```sql
USE ROLE SECURITYADMIN;
ALTER USER ORDINATE_SVC SET RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…';
DESC USER ORDINATE_SVC;  -- RSA_PUBLIC_KEY_FP is the SHA256:… fingerprint Ordinate's token names
```

In Ordinate, paste the whole of `ordinate_svc.p8` (including its `-----BEGIN ENCRYPTED PRIVATE
KEY-----` line) into **Private key or access token**, and the passphrase into **Private key
passphrase**. To rotate: set `RSA_PUBLIC_KEY_2` to the new public key, **Replace** the key in
Ordinate, then unset the old one.

A PAT instead: `ALTER USER ORDINATE_SVC ADD PROGRAMMATIC ACCESS TOKEN ordinate ROLE_RESTRICTION =
'ORDINATE_READER';`, then choose **Programmatic access token** and paste the token. By default
Snowflake accepts a PAT only from a user under a network policy, so put your Ordinate egress
addresses in one.

### The account identifier and the network

The **Account** field takes your account identifier, `myorg-myaccount` or a locator such as
`xy12345.us-east-2.aws`. It does not take a URL. Ordinate builds the address itself,
`https://<account>.snowflakecomputing.com`, and refuses anything that is not an identifier (letters,
digits, `_` and `-`, at most four dot-separated parts). So a connection can only reach a subdomain of
`snowflakecomputing.com` (threat model R-L4).

Ordinate's pods need HTTPS egress (port 443) to `<account>.snowflakecomputing.com`. Every request
also goes through the server's SSRF guard: the name is resolved, refused if it resolves to an
internal address, and the socket is pinned to the address that was checked.

**PrivateLink.** Tick **Connect over PrivateLink** to use
`<account>.privatelink.snowflakecomputing.com`. That name resolves to your VPC endpoint, which is a
private address, so the SSRF guard refuses it until you allow the endpoint's subnet with
[`SSRF_ALLOW`](configuration.md), for example `SSRF_ALLOW=10.20.30.0/24`.

### What Ordinate sends

- One statement per request (`MULTI_STATEMENT_COUNT = 1`). A query typed in the workbench runs inside
  `select * from ( … ) limit N+1`, so the row limit holds whatever the query says.
- A statement timeout of 30 seconds for a connection's queries. When the timeout passes, or the person
  closes the tab, Ordinate cancels the statement, so no query is left running on the warehouse.
- `QUERY_TAG = 'ordinate:<org>'`, followed by `:live` or `:extract` when Ordinate knows what the query
  is for. To see what Ordinate ran and what it cost:

  ```sql
  SELECT start_time, query_tag, warehouse_name, total_elapsed_time, bytes_scanned
  FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
  WHERE query_tag LIKE 'ordinate:%'
  ORDER BY start_time DESC;
  ```

- `TIMEZONE = 'UTC'` and `WEEK_START = 1` (ISO weeks start on Monday). Timestamps arrive as UTC; a
  `TIMESTAMP_TZ` keeps its instant.
- Values in a live query are bind parameters, never text in the SQL.

To cap what the warehouse can spend, give Ordinate its own warehouse with a resource monitor (needs
`ACCOUNTADMIN`):

```sql
USE ROLE ACCOUNTADMIN;
CREATE RESOURCE MONITOR ordinate_monthly WITH CREDIT_QUOTA = 100
  TRIGGERS ON 90 PERCENT DO NOTIFY ON 100 PERCENT DO SUSPEND;
ALTER WAREHOUSE ORDINATE_WH SET RESOURCE_MONITOR = ordinate_monthly;
```
