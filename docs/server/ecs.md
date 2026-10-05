# Amazon ECS on Fargate

Ordinate runs on ECS as one container per task, behind an ALB:

- Postgres is RDS.
- Tables live in S3, reached through the **task role**.
- Secrets come from **AWS Secrets Manager** and are injected as environment variables at task start.

The pieces you provide are the same as for EKS: [eks.md](eks.md) §1, the S3 permissions policy in
§2 and the database role and TLS choices in §3 all apply unchanged. That page also describes what was
tested and what was not. In short, nothing on this page has been run on AWS. The task definition
below parses, and `scripts/test-serverDocs.ts` checks that every variable it names is one the server
reads.

## Secrets Manager

Create one secret, for example `ordinate/prod`, holding a JSON object with three keys:
`DATABASE_URL`, `ORDINATE_MASTER_KEY` (32 random bytes, base64, from `openssl rand -base64 32`) and,
for OIDC, `OIDC_CLIENT_SECRET`. The task definition refers to each key by its own ARN suffix
(`:<key>::`), and ECS resolves the keys when the task starts. **Keep a copy of the master key
outside this secret too.** It is the one value a database backup cannot replace.

The **task execution role** (used by ECS, not the app) needs `secretsmanager:GetSecretValue` on that
secret, `kms:Decrypt` if the secret uses a customer-managed key, and CloudWatch Logs write access.
The **task role** (used by the app) needs only the S3 policy from [eks.md](eks.md#2-s3-and-irsa),
with nothing in its trust policy beyond `ecs-tasks.amazonaws.com`. DuckDB's credential chain picks
the role up from the endpoint ECS injects (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`), so the task
needs no AWS keys.

## Task definition

```json
{
  "family": "ordinate",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "2048",
  "memory": "4096",
  "runtimePlatform": { "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX" },
  "ephemeralStorage": { "sizeInGiB": 30 },
  "executionRoleArn": "arn:aws:iam::123456789012:role/ordinate-task-execution",
  "taskRoleArn": "arn:aws:iam::123456789012:role/ordinate-task",
  "containerDefinitions": [
    {
      "name": "ordinate",
      "image": "ghcr.io/ashishb2000/ordinate:0.1.0",
      "essential": true,
      "portMappings": [
        { "name": "http", "containerPort": 8080, "protocol": "tcp" },
        { "name": "metrics", "containerPort": 9464, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "AUTH_MODE", "value": "oidc" },
        { "name": "OIDC_ISSUER", "value": "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0" },
        { "name": "OIDC_CLIENT_ID", "value": "11111111-1111-1111-1111-111111111111" },
        { "name": "OIDC_REDIRECT_URL", "value": "https://ordinate.example.com/api/auth/callback" },
        { "name": "ORDINATE_ADMIN_EMAIL", "value": "admin@example.com" },
        { "name": "ALLOWED_EMAIL_DOMAINS", "value": "example.com" },
        { "name": "TRUSTED_PROXY_CIDRS", "value": "10.0.0.0/20,10.0.16.0/20" },
        { "name": "STORAGE_URL", "value": "s3://acme-ordinate/prod" },
        { "name": "S3_REGION", "value": "us-east-1" },
        { "name": "SSRF_ALLOW", "value": "10.0.64.0/20" },
        { "name": "METRICS_PORT", "value": "9464" },
        { "name": "DUCKDB_THREADS", "value": "2" }
      ],
      "secrets": [
        { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:ordinate/prod-AbCdEf:DATABASE_URL::" },
        { "name": "ORDINATE_MASTER_KEY", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:ordinate/prod-AbCdEf:ORDINATE_MASTER_KEY::" },
        { "name": "OIDC_CLIENT_SECRET", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:ordinate/prod-AbCdEf:OIDC_CLIENT_SECRET::" }
      ],
      "healthCheck": {
        "command": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"],
        "interval": 15,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      },
      "stopTimeout": 30,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/ordinate",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ordinate"
        }
      }
    }
  ]
}
```

Notes on the fields:

- **The image sets `ORDINATE_ENV=prod`, `PORT=8080`, `DATA_DIR=/data` and the DuckDB extension
  directory.** Do not repeat them here. Every other variable is listed in
  [configuration.md](configuration.md).
- **`healthCheck`** is the image's own `HEALTHCHECK` command. ECS ignores a Dockerfile health check
  unless the task definition repeats it.
- **`DUCKDB_THREADS`**: set it to the task's vCPU count. Inside a container with a CPU limit, Node 24
  derives the default from that limit (configuration.md shows the measurements). What Node reports
  inside a Fargate task was not measured, so set the value explicitly.
- **`runtimePlatform`**: the image is published for `ARM64` (Graviton) and `X86_64`. Pick either.
- **`ephemeralStorage`**: `/data` holds the S3 cache (`STORAGE_CACHE_MB`, 2 GiB by default),
  uploads in flight and DuckDB's spill files. 30 GiB leaves room. The root filesystem stays writable
  here. To make it read-only like the Helm chart does, mount writable volumes at `/data` and
  `/tmp`, and check on the first deploy that uid 1000 can write both. `/readyz` fails if DuckDB
  cannot.
- **`secrets`** are resolved once, at task start. After rotating a value, force a new deployment.

## Service and load balancer

- **Target group**: protocol HTTP, port 8080, target type `ip`, health check path `/readyz`.
  **Turn on stickiness (`lb_cookie`) when the service runs more than one task.** Uploads, downloads
  and AI plan runs are held by the task that started them (threat model R8).
- **Listener**: HTTPS 443 with your ACM certificate. Never route `/metrics`. It lives on port 9464
  only, so expose that port to your scraper's security group and nothing else.
- **Security groups**: the ALB may reach the tasks on 8080; the tasks may reach RDS on 5432 and
  HTTPS 443 (S3, your IdP, AI providers, GHCR), plus any database a connector reads. Without a
  public IP, the tasks reach GHCR and the IdP through a NAT gateway, and S3 through a gateway
  endpoint.
- **Deployments**: `minimumHealthyPercent` 100 and `maximumPercent` 200, so a new task is healthy
  before an old one stops. With a circuit breaker on, a task that cannot boot rolls back
  automatically.

## Migrations

ECS has no pre-upgrade hook. The server migrates at boot instead, inside one transaction, under a
Postgres advisory lock. When several tasks start together, exactly one applies the migrations and
the others wait, then apply nothing. T7.2 measured 3 pods on a fresh database: one applied all 8,
and the two others waited 178 ms and 435 ms. To fail before any task rolls, the way the Helm hook
does, run a one-off task from the new task definition first, with the container's command
overridden to `["node", "src/server/db/migrateMain.js"]`. It exits 0 when the schema is current and
1 with one line otherwise. Migrations are additive. Read [upgrade.md](upgrade.md) before rolling
back.

## Pulling from GHCR

GHCR packages are private until the repository owner makes them public. For a private package, add
`repositoryCredentials` with a Secrets Manager secret holding a GitHub username and a token with
`read:packages`, or mirror the image into ECR.
