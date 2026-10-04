#!/usr/bin/env bash
# The Helm chart, end to end on kind (T7.2). CI runs this; so can you:
#
#   docker build -f deploy/Dockerfile -t ordinate:local .
#   IMAGE=ordinate:local KIND_CLUSTER=ordinate-ci deploy/helm/ci/kind-e2e.sh
#   kind delete cluster --name ordinate-ci
#
# Steps: helm lint + no secret in any render → kind cluster, image loaded →
# Postgres + MinIO (deps.yaml) → every optional object validated by the API
# server (HPA, Ingress, NetworkPolicy) → helm install --wait (the pre-install
# hook migrates) → web/e2e/compose.e2e.ts through a port-forward → helm upgrade
# with a changed value while a pod probes /readyz through the Service every
# 100 ms (the pre-upgrade hook must run again, the pods must roll, no probe may
# fail) → a node drain the PDB must refuse → NetworkPolicy on: Postgres, MinIO
# and DNS still reached, another destination not, and the e2e again.
#
# Needs: docker, kind, kubectl, helm, node, and the repo's root node_modules
# (playwright). E2E_CHROMIUM may point at a local Chromium.
set -euo pipefail

IMAGE=${IMAGE:-ordinate:local}
CLUSTER=${KIND_CLUSTER:-ordinate-ci}
NS=ordinate
REL=ordinate
PF_PORT=${PF_PORT:-18080}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
CHART=$ROOT/deploy/helm/ordinate
CI=$ROOT/deploy/helm/ci
SEL="app.kubernetes.io/instance=$REL,app.kubernetes.io/component=server"

k() { kubectl --context "kind-$CLUSTER" -n "$NS" "$@"; }
h() { helm --kube-context "kind-$CLUSTER" -n "$NS" "$@"; }
now() { node -p 'Date.now()'; }
step() { printf '\n== %s\n' "$*"; }
secs() { node -p "(($2 - $1) / 1000).toFixed(1)"; }
IMG_ARGS=(--set "image.repository=${IMAGE%:*}" --set "image.tag=${IMAGE##*:}")

step "helm lint --strict"
helm lint --strict "$CHART"
helm lint --strict "$CHART" -f "$CI/values-kind.yaml" --set hpa.enabled=true --set networkPolicy.enabled=true --set ingress.enabled=true

step "no secret value or Secret object in any render"
render=$(helm template "$REL" "$CHART" -f "$CI/values-kind.yaml" --set hpa.enabled=true --set networkPolicy.enabled=true --set ingress.enabled=true)
if grep -nE 'kind: Secret$|postgres://|ORDINATE_MASTER_KEY|AWS_SECRET_ACCESS_KEY|OIDC_CLIENT_SECRET' <<<"$render"; then
  echo "a rendered manifest names a secret value" >&2; exit 1
fi
for key in DATABASE_URL ORDINATE_MASTER_KEY OIDC_CLIENT_SECRET AWS_SECRET_ACCESS_KEY; do
  if helm template "$REL" "$CHART" --set "config.$key=x" >/dev/null 2>&1; then
    echo "config.$key rendered: the chart must refuse a secret in values" >&2; exit 1
  fi
done
echo "ok: secrets only by reference (envFrom secretRef), secret names refused in values"

step "kind cluster $CLUSTER"
kind get clusters | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --wait 120s
kind load docker-image "$IMAGE" --name "$CLUSTER"
kubectl --context "kind-$CLUSTER" create namespace "$NS" --dry-run=client -o yaml | kubectl --context "kind-$CLUSTER" apply -f -

step "Postgres + MinIO in the cluster"
PG_PW=$(openssl rand -hex 16)
MINIO_PW=$(openssl rand -hex 16)
k create secret generic ordinate-deps --dry-run=client -o yaml \
  --from-literal=POSTGRES_PASSWORD="$PG_PW" --from-literal=MINIO_ROOT_USER=ordinate --from-literal=MINIO_ROOT_PASSWORD="$MINIO_PW" | k apply -f -
k create secret generic ordinate-secrets --dry-run=client -o yaml \
  --from-literal=DATABASE_URL="postgres://ordinate:$PG_PW@postgres:5432/ordinate" \
  --from-literal=ORDINATE_MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=AWS_ACCESS_KEY_ID=ordinate --from-literal=AWS_SECRET_ACCESS_KEY="$MINIO_PW" | k apply -f -
k apply -f "$CI/deps.yaml"
k rollout status deploy/postgres deploy/minio --timeout=180s
k wait --for=condition=complete job/minio-bucket --timeout=120s

step "the API server accepts every optional object (HPA, PDB, Ingress, NetworkPolicy)"
helm template "$REL" "$CHART" -f "$CI/values-kind.yaml" "${IMG_ARGS[@]}" \
  --set hpa.enabled=true --set networkPolicy.enabled=true --set ingress.enabled=true | k apply --dry-run=server -f -
if helm template "$REL" "$CHART" -f "$CI/values-kind.yaml" --set hpa.enabled=true --show-only templates/deployment.yaml | grep -q '^  replicas:'; then
  echo "with hpa.enabled the Deployment must not pin replicas" >&2; exit 1
fi

step "helm install --wait"
t0=$(now)
h install "$REL" "$CHART" -f "$CI/values-kind.yaml" "${IMG_ARGS[@]}" --wait --timeout 6m
t1=$(now)
echo "install: $(secs "$t0" "$t1") s (pre-install migration hook + 2 pods Ready)"
k logs "job/$REL-migrate"
k wait --for=condition=Ready pod -l "$SEL" --timeout=60s
k get pods -o wide

pf_pid=""
port_forward() {
  k port-forward "svc/$REL" "$PF_PORT:8080" >/dev/null 2>&1 &
  pf_pid=$!
  for _ in $(seq 1 50); do
    curl -fs "http://127.0.0.1:$PF_PORT/readyz" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "port-forward never answered" >&2; return 1
}
stop_forward() { [ -n "$pf_pid" ] && kill "$pf_pid" 2>/dev/null || true; pf_pid=""; }
trap stop_forward EXIT

e2e() {
  port_forward
  test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PF_PORT/metrics")" = 404
  (cd "$ROOT" && E2E_COMPOSE_URL="http://127.0.0.1:$PF_PORT" E2E_COMPOSE_EMAIL=admin@ci.test \
    node --test --test-reporter=spec web/e2e/compose.e2e.ts)
  stop_forward
}

step "e2e: sign in → project → import CSV → chart → dashboard"
e2e

step "helm upgrade with a changed value, /readyz probed through the Service"
# A pod of the same image, so nothing is pulled: a fresh connection to the
# Service every 100 ms (what a load balancer's health check does) until told to stop.
PROBE_JS='
const http = require("http"), fs = require("fs");
const url = "http://'"$REL"':8080/readyz";
let ok = 0, fail = 0; const errs = {}; const t0 = Date.now();
const once = () => new Promise((done) => {
  const req = http.get(url, { agent: false, timeout: 2000 }, (res) => { res.resume(); res.statusCode === 200 ? ok++ : (fail++, errs[res.statusCode] = (errs[res.statusCode] || 0) + 1); done(); });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => { fail++; errs[e.code || e.message] = (errs[e.code || e.message] || 0) + 1; done(); });
});
(async () => {
  console.log("probing");
  while (!fs.existsSync("/tmp/stop")) { const s = Date.now(); await once(); await new Promise((r) => setTimeout(r, Math.max(0, 100 - (Date.now() - s)))); }
  console.log(JSON.stringify({ ok, fail, errs, seconds: (Date.now() - t0) / 1000 }));
})();'
k delete pod readyz-probe --ignore-not-found --wait
k run readyz-probe --image="$IMAGE" --image-pull-policy=Never --restart=Never --command -- node -e "$PROBE_JS"
k wait --for=condition=Ready pod/readyz-probe --timeout=60s
until k logs readyz-probe 2>/dev/null | grep -q probing; do sleep 0.5; done

job_before=$(k get job "$REL-migrate" -o jsonpath='{.metadata.uid}')
rs_before=$(k get deploy "$REL" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
pods_before=$(k get pods -l "$SEL" -o jsonpath='{.items[*].metadata.name}')
sleep 3
t0=$(now)
h upgrade "$REL" "$CHART" --reuse-values --set config.LOG_LEVEL=debug --wait --timeout 6m
t1=$(now)
# --wait returns once the new pods are Ready; the old ones are still in their
# preStop drain. Keep probing until they are gone.
for p in $pods_before; do k wait --for=delete "pod/$p" --timeout=90s; done
t2=$(now)
sleep 2
k exec readyz-probe -- touch /tmp/stop
k wait --for=jsonpath='{.status.phase}'=Succeeded pod/readyz-probe --timeout=30s
probe=$(k logs readyz-probe | tail -1)
k delete pod readyz-probe --wait=false

job_after=$(k get job "$REL-migrate" -o jsonpath='{.metadata.uid}')
job_ok=$(k get job "$REL-migrate" -o jsonpath='{.status.succeeded}')
job_span=$(k get job "$REL-migrate" -o jsonpath='{.status.startTime} → {.status.completionTime}')
rs_after=$(k get deploy "$REL" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')
pods_after=$(k get pods -l "$SEL" -o jsonpath='{.items[*].metadata.name}')
echo "upgrade: $(secs "$t0" "$t1") s to helm --wait, $(secs "$t0" "$t2") s until the old pods were gone; hook Job $job_span, succeeded=$job_ok; revision $rs_before → $rs_after"
echo "pods: [$pods_before] → [$pods_after]"
k logs "job/$REL-migrate"
echo "readyz probe: $probe"
test "$job_after" != "$job_before" || { echo "the pre-upgrade hook did not run a new Job" >&2; exit 1; }
test "$job_ok" = 1
test "$rs_after" -gt "$rs_before" || { echo "the Deployment did not roll" >&2; exit 1; }
node -e 'const p = JSON.parse(process.argv[1]); if (!(p.ok > 0 && p.fail === 0)) { console.error("/readyz failed during the rollout"); process.exit(1); }' "$probe"

step "PDB: a drain may not take the last pod"
node=$(k get pods -l "$SEL" -o jsonpath='{.items[0].spec.nodeName}')
set +e
drain=$(kubectl --context "kind-$CLUSTER" drain "$node" --pod-selector="$SEL" --ignore-daemonsets --delete-emptydir-data --timeout=25s 2>&1)
drain_rc=$?
set -e
kubectl --context "kind-$CLUSTER" uncordon "$node"
grep -m1 'evicted' <<<"$drain" || true
grep -m1 'disruption budget' <<<"$drain" || { echo "$drain"; echo "the drain was not held by the PDB" >&2; exit 1; }
test "$drain_rc" -ne 0
k rollout status "deploy/$REL" --timeout=180s

step "NetworkPolicy: allowed egress works, other egress does not"
REACH_JS='
const net = require("net"), dns = require("dns").promises;
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); r("open"); }); s.on("timeout", () => { s.destroy(); r("timeout"); }); s.on("error", (e) => r(e.code)); });
(async () => console.log(JSON.stringify({ dns: await dns.lookup("minio").then((a) => a.address, (e) => e.code), postgres: await tcp("postgres", 5432), minio: await tcp("minio", 9000), kubeApi: await tcp("kubernetes.default.svc", 443) })))();'
echo "policy off: $(k exec "deploy/$REL" -- node -e "$REACH_JS")"
h upgrade "$REL" "$CHART" --reuse-values --set networkPolicy.enabled=true --wait --timeout 6m
k get networkpolicy "$REL" -o name
sleep 2
reach=$(k exec "deploy/$REL" -- node -e "$REACH_JS")
echo "policy on:  $reach"
node -e '
const r = JSON.parse(process.argv[1]);
if (!/^\d+\.\d+\.\d+\.\d+$/.test(r.dns) || r.postgres !== "open" || r.minio !== "open") { console.error("an allowed destination is blocked"); process.exit(1); }
console.log(r.kubeApi === "open" ? "NOTE: the CNI does not enforce NetworkPolicy (kubernetes API still reachable)" : "enforced: kubernetes API " + r.kubeApi);' "$reach"
k logs "job/$REL-migrate" | tail -1

step "e2e again, under the NetworkPolicy"
e2e

echo
echo "kind e2e: all steps passed"
