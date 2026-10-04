# Amazon EKS: Helm, IRSA, RDS, S3 and an ALB

This page deploys the chart in `deploy/helm/ordinate` (also attached to every GitHub Release as
`ordinate-<version>.tgz`) into an EKS cluster:

- Parquet tables go in an S3 bucket. The pods reach it through IRSA, with no keys.
- Metadata goes in RDS for PostgreSQL.
- Traffic arrives through an internal ALB, created by the AWS Load Balancer Controller, with TLS
  from ACM.
- People sign in with OIDC.

**What was tested and what was not.** The chart, its hook Job, an upgrade, a rollback and the
`values-eks.yaml` below were run on kind (kind v0.33, Kubernetes v1.37; T7.2 and T7.3). The API server accepted
every object, including the ALB Ingress with its annotations. IRSA, a real ALB, RDS and AWS S3 have
**not** been run. The AWS-side setup below is therefore given as policies and settings, with links
to AWS's own instructions, not as commands to paste.

## 1. What you provide

| Piece | Notes |
|---|---|
| EKS cluster, Kubernetes ≥ 1.25 | `kubeVersion` in `Chart.yaml`. Nodes can be amd64 or arm64 (Graviton), because the image is multi-arch. |
| [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/) | Turns the chart's Ingress into an ALB. |
| An IAM OIDC provider for the cluster | Needed for IRSA ([AWS docs](https://docs.aws.amazon.com/eks/latest/userguide/enable-iam-roles-for-service-accounts.html)). |
| RDS for PostgreSQL 17 | Ordinate's CI and every measurement in `docs/phase-7-web/log.md` use Postgres 17. Put it in private subnets, and let its security group accept 5432 from the pods. |
| An S3 bucket | Block all public access, keep default encryption on, and turn on versioning (see [backup-restore.md](backup-restore.md)). |
| An ACM certificate | For the hostname people open. |
| An OIDC client at your IdP | Redirect URL `https://<host>/api/auth/callback`, see [sso.md](sso.md). |

## 2. S3 and IRSA

The pods sign S3 requests with whatever DuckDB's AWS credential chain finds. Under IRSA that is the
web-identity token EKS mounts into the pod ([configuration.md](configuration.md#read-by-libraries-not-by-ordinate)).
Ordinate reads and writes objects only under `<prefix>/orgs/<org>/…`: it does ranged GETs and HEADs,
and it writes with PUT or multipart upload, so new tables are immutable new keys. The garbage
collector DELETEs versions no record names any more (`STORAGE_GC_GRACE_MINUTES` after they stopped
being named).

The IAM role's permissions policy, for bucket `acme-ordinate` with `STORAGE_URL=s3://acme-ordinate/prod`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OrdinateTables",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::acme-ordinate/prod/*"
    },
    {
      "Sid": "OrdinateList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::acme-ordinate",
      "Condition": { "StringLike": { "s3:prefix": ["prod/*"] } }
    }
  ]
}
```

`s3:ListBucket` makes a missing key answer 404 instead of 403. Its trust policy lets the chart's
service account assume it. With release name `ordinate` in namespace `ordinate`, the service account
is `ordinate`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:ordinate:ordinate",
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

Add a lifecycle rule that aborts incomplete multipart uploads after a day. A pod killed during a
large write leaves invisible parts behind (T5.2).

## 3. RDS

<a id="rds"></a>

Run the app as an **ordinary role that owns its database**, not as the RDS master user. The schema
uses forced row-level security as a second tenant wall, and a superuser or `BYPASSRLS` role skips
it (`0007_records.sql`). As the master user, in `psql`:

```sql
CREATE ROLE ordinate LOGIN PASSWORD '<password>';
CREATE DATABASE ordinate OWNER ordinate;
```

That is all the app needs: it creates and migrates its own tables. These statements were run on
Postgres 17 with the role names changed, then `node src/server/db/migrateMain.js` applied all 8
migrations as that role (T7.3). For logical backups, add a separate role, as described in
[backup-restore.md](backup-restore.md#postgres).

**TLS.** RDS for PostgreSQL 15 and later enforces TLS by default (`rds.force_ssl`; check your
parameter group), and its certificates chain to
Amazon's own CA, which Node does not trust. With `sslmode=require` or `verify-full` and nothing
else, the pod exits at boot with `unable to verify the first certificate`. You have two choices:

1. **Verify**: recommended. Build a derived image that carries the
   [RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html),
   point `NODE_EXTRA_CA_CERTS` at it, and use `?sslmode=verify-full`:

   ```dockerfile
   FROM ghcr.io/ashishb2000/ordinate:<version>
   COPY global-bundle.pem /etc/ordinate/db-ca.pem
   ENV NODE_EXTRA_CA_CERTS=/etc/ordinate/db-ca.pem
   ```

   Then set `image.repository` and `image.tag` to your copy.
2. **Encrypt without verifying**: `?sslmode=no-verify`. The traffic is encrypted, but nothing checks
   who answers.

All four behaviours were measured against a Postgres serving a certificate from a private CA
(T7.3):

| Setup | Result |
|---|---|
| `sslmode=require`, base image | exits with the error above |
| `sslmode=verify-full`, base image | exits with the error above |
| `sslmode=no-verify` | `/readyz` ok, `pg_stat_ssl` shows TLS |
| `sslmode=verify-full`, derived image | `/readyz` ok, `pg_stat_ssl` shows TLS |

Size the RDS instance's `max_connections` for at least **10 per pod**, plus the migration Job and
your own sessions. Each pod's pool is fixed at 10 (`src/server/db/pool.ts`).

## 4. The Secret

The chart never takes a secret from values. Create one Secret in the release namespace before
installing (from `deploy/helm/ordinate/values.yaml`):

```bash
kubectl create secret generic ordinate \
  --from-literal=DATABASE_URL='postgres://ordinate:…@db.internal:5432/ordinate' \
  --from-literal=ORDINATE_MASTER_KEY="$(openssl rand -base64 32)"
```

For OIDC, add `--from-literal=OIDC_CLIENT_SECRET=…`. Under IRSA there are no AWS keys to add. Every
key in the Secret becomes an environment variable of the pods and the migration Job. **Back up
`ORDINATE_MASTER_KEY` outside the cluster.** Without it, every stored connection password and AI
key is unreadable. If you keep it in AWS Secrets Manager, a tool such as the External Secrets
Operator can create this Secret from it. A change to the Secret needs
`kubectl rollout restart deploy/ordinate`.

## 5. Values

`values-eks.yaml`, with every placeholder replaced by your own value:

<!-- values-eks:start -->
```yaml
existingSecret: ordinate
replicaCount: 2

config:
  AUTH_MODE: oidc
  OIDC_ISSUER: https://example.okta.com/oauth2/default
  OIDC_CLIENT_ID: 0oa1example
  OIDC_REDIRECT_URL: https://ordinate.example.com/api/auth/callback
  ORDINATE_ADMIN_EMAIL: admin@example.com
  ALLOWED_EMAIL_DOMAINS: example.com
  # The ALB connects to pod IPs from its own subnets: name them, so its
  # X-Forwarded-For identifies clients for the rate limits.
  TRUSTED_PROXY_CIDRS: "10.0.0.0/20,10.0.16.0/20"
  STORAGE_URL: s3://acme-ordinate/prod
  S3_REGION: us-east-1
  # Internal subnets that connectors may read (databases in this VPC).
  SSRF_ALLOW: "10.0.64.0/20"

serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/ordinate-s3

ingress:
  enabled: true
  className: alb
  annotations:
    alb.ingress.kubernetes.io/scheme: internal
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000
    alb.ingress.kubernetes.io/healthcheck-path: /readyz
    # Uploads, downloads and AI plan runs are held by the pod that started
    # them: with more than one pod, a browser must keep reaching the same one.
    alb.ingress.kubernetes.io/target-group-attributes: stickiness.enabled=true,stickiness.type=lb_cookie,stickiness.lb_cookie.duration_seconds=86400
  hosts:
    - host: ordinate.example.com
      paths:
        - path: /
          pathType: Prefix

resources:
  requests:
    cpu: "1"
    memory: 2Gi
  limits:
    cpu: "2"
    memory: 4Gi
```
<!-- values-eks:end -->

**Sticky sessions are required with more than one pod.** Upload and download tokens, staged imports
and AI plan runs live in the memory of the pod that issued them (threat model R8,
`src/server/files.ts`). Without stickiness, an import whose upload landed on another pod fails
with "That upload has expired". The chart's own e2e reaches a single pod through a port-forward, so it does not
exercise this. With one replica, or before you have an ALB, stickiness does not matter.

`/metrics` gets its own `ordinate-metrics` Service and is never routed by the Ingress. The default
`resources` are small (250m / 512Mi request, 2 CPU / 2Gi limit). The values above are a starting
point, explained in [sizing.md](sizing.md).

## 6. Install

From a release:

```bash
helm install ordinate ordinate-<version>.tgz -n ordinate -f values-eks.yaml --wait --timeout 10m
```

Or from a checkout (`deploy/helm/ordinate/values.yaml`):

```bash
helm install ordinate deploy/helm/ordinate -n ordinate -f values-eks.yaml --wait --timeout 10m
```

The pre-install hook Job migrates Postgres first. If it fails, `helm install` fails and no pod
starts. `kubectl -n ordinate logs job/ordinate-migrate` shows one line naming the problem, such as a
bad variable or an unreachable database. Then:

```bash
kubectl -n ordinate get pods,ingress
```

The Ingress shows the ALB's address. Point your DNS name at it, open `https://<host>`, and sign in
as `ORDINATE_ADMIN_EMAIL`.

## 7. Recommended hardening

- `networkPolicy.enabled: true`, with `ingressFrom` limited to the VPC's ALB subnets. List
  `egress` for RDS (5432), HTTPS (443, for S3, your IdP and AI providers), and every database a
  connector reads. The chart's comments give the shapes. EKS enforces NetworkPolicy only with the
  VPC CNI's network policy agent or another enforcing CNI.
- Block the instance metadata endpoint from pods (IMDSv2 with hop limit 1). IRSA does not need it,
  and Ordinate's SSRF guard refuses it for connectors anyway.
- `hpa.enabled: true` once you know your load. The PDB keeps one pod during node drains.
