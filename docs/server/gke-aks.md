# GKE and AKS notes

<sub>[← All operator docs](README.md)</sub>

The Helm chart is cloud-neutral. Install it exactly as in [eks.md](eks.md) §4–6: one Secret, a
values file, `helm install`. This page covers what differs on Google Kubernetes Engine and Azure
Kubernetes Service. **Nothing here has been run on GKE or AKS.** What *has* been run is the chart on
kind, MinIO as the S3 store, and Postgres with TLS from a private CA (T7.2, T7.3). Where a cloud
service has to stand in for one of those, the gap is stated.

Four things hold everywhere:

- **Sticky sessions with more than one pod.** Uploads, downloads and AI plan runs are held by the
  pod that started them (threat model R8). Configure cookie affinity on whatever load balancer
  fronts the Service.
- **The image is multi-arch.** Arm nodes (GKE Tau T2A / C4A, AKS Ampere Altra) work like amd64.
- **`/metrics` is on its own Service** (`ordinate-metrics`, port 9464). Never route it through the
  ingress.
- **Postgres 17 is what was tested.** Run the app as an ordinary role that owns its database, as
  described in [eks.md](eks.md#rds), and see [backup-restore.md](backup-restore.md#postgres) for
  logical dumps under forced RLS.

## GKE

| Piece | Notes |
|---|---|
| Ingress | GKE Ingress (`className: gce`, or `gce-internal`). With container-native load balancing (the default on VPC-native clusters), the load balancer's health check follows the pod's readiness probe, `/readyz`. Cookie affinity goes in a `BackendConfig` (`sessionAffinity.affinityType: GENERATED_COOKIE`), attached through `service.annotations` with `cloud.google.com/backend-config`. |
| Postgres | Cloud SQL with a **private IP**. The chart has no sidecar slot for the Cloud SQL Auth Proxy. Cloud SQL server certificates come from a per-instance CA, so verifying them needs the derived-image approach in [eks.md](eks.md#rds) with that CA. The alternative is `sslmode=no-verify`. |
| Table storage | Google Cloud Storage through its S3-compatible XML API: `STORAGE_URL=s3://<bucket>/<prefix>`, `S3_ENDPOINT=https://storage.googleapis.com`, `S3_REGION=auto`, plus an **HMAC key** as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the Secret. Workload Identity cannot sign these requests, so the key is static: scope its service account to the one bucket. **Untested**: Ordinate's S3 path has run against MinIO only. Multipart uploads and the garbage collector's DELETEs against GCS are the parts to watch. The tested alternative is file mode on a ReadWriteMany volume (Filestore) with `data.existingClaim`. |
| NetworkPolicy | Enforced with GKE Dataplane V2. |
| Egress | The pods need the IdP, Cloud Storage and AI providers on 443 (through Cloud NAT if the nodes are private), plus whatever connectors read, listed in `SSRF_ALLOW` when private. |

## AKS

| Piece | Notes |
|---|---|
| Ingress | With the application routing add-on (managed NGINX, `className: webapprouting.kubernetes.azure.com`), cookie affinity is the annotation `nginx.ingress.kubernetes.io/affinity: cookie` in `ingress.annotations`. With Application Gateway for Containers or AGIC, use that controller's cookie-affinity setting. Ordinate sends `X-Accel-Buffering: no` on its event stream, so NGINX does not buffer it. |
| Postgres | Azure Database for PostgreSQL Flexible Server, which requires TLS by default. Its server certificates chain to public roots (DigiCert / Microsoft) that Node already trusts, so `sslmode=verify-full` should work without a custom CA. Not tested. |
| Table storage | **Azure Blob Storage has no S3 API, and Ordinate has no Azure Blob driver.** The choices: file mode on a ReadWriteMany Azure Files volume (`data.existingClaim`; DuckDB's performance over SMB/NFS has not been measured), or one replica on a ReadWriteOnce disk, or an S3-compatible store you operate. Of the three clouds, AKS is the least proven target. |
| Identity | Microsoft Entra Workload ID does not apply to table storage (no S3 path). For sign-in with Entra ID, see [sso.md](sso.md#microsoft-entra-id-azure-ad). |
| NetworkPolicy | Enforced with Azure CNI powered by Cilium, or with Azure / Calico network policy. |
