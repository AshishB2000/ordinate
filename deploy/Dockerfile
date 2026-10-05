# syntax=docker/dockerfile:1
# Ordinate server image (T7.1). Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t ordinate .
#
# Three stages: `build` compiles the server (tsc) and the web app (Vite) and
# fetches the map GeoJSON; `deps` installs production node_modules and DuckDB's
# httpfs + aws extensions into a baked directory; the runtime stage copies what
# the server reads at run time and nothing else. The
# container never downloads anything at run time: the server only LOADs the
# extensions (autoinstall off, src/engine/storage.ts) from DUCKDB_EXTENSION_DIR.
# Secrets (ORDINATE_MASTER_KEY, DATABASE_URL, S3 keys, OIDC secret) come from
# the environment at run time — none is baked.
#
# Multi-arch (T7.3, .github/workflows/release.yml):
#
#   docker buildx build --platform linux/amd64,linux/arm64 -f deploy/Dockerfile .
#
# `build` runs on the BUILDER's platform: its output (JS, the web bundle, GeoJSON)
# is the same on every arch, and tsc + Vite under QEMU are the slow, fragile
# part of an emulated build. Everything native — the DuckDB binding npm picks by
# cpu, the extensions DuckDB picks by its own platform — is installed in `deps`,
# which runs on the TARGET platform, and checked there against TARGETARCH.

ARG NODE_IMAGE=node:24-slim

# ── build ────────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
# Electron is a devDependency (the desktop app until T8.1): never fetch its binary.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json web/
# --ignore-scripts: postinstall would build the desktop (Svelte) and fetch geo; both are done explicitly below.
RUN npm ci --ignore-scripts --no-audit --no-fund && npm --prefix web ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build:ts && npm --prefix web run build
# The boundary GeoJSON, as postinstall fetches it — and the build FAILS rather
# than ship download-geo's empty placeholder (its fallback when a fetch fails).
RUN node scripts/download-geo.js \
 && node -e "const fs=require('fs'),{geoJsonText}=require('./src/server/geo');for(const f of ['world-countries.js','us-states.js','us-counties.json']){const n=JSON.parse(geoJsonText(f,fs.readFileSync('assets/geo/'+f,'utf8'))).features.length;console.log(f,n,'features');if(!n)process.exit(1)}"
# The runtime runs the emitted .js; the .ts beside it ships nowhere.
RUN find src renderer -name '*.ts' -delete

# ── production node_modules ──────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
ARG TARGETARCH
WORKDIR /app
# binutils: `strip` for libduckdb.so below (this stage only; the runtime never sees it).
RUN apt-get update && apt-get install -y --no-install-recommends binutils && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --omit=dev drops Electron, electron-builder, Svelte, Playwright, TypeScript.
# Then the prod dependencies only the DESKTOP renderer loads (renderer/hub's
# <script src="../../node_modules/…"> and lazyScript): the web app bundles its
# own Chart.js plugins and MapLibre (web/), and the server never requires these.
# chart.js stays — src/publish inlines it into published sites.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm uninstall --omit=dev --no-save --ignore-scripts --no-audit --no-fund \
      maplibre-gl pdfmake pptxgenjs \
      chartjs-chart-financial chartjs-chart-matrix chartjs-chart-sankey chartjs-chart-treemap @sgratzl/chartjs-chart-boxplot \
 # oracledb runs in thin mode only (CLAUDE.md: never initOracleClient) — its thick-mode binaries are dead weight.
 # npm does not filter optional packages by libc: node:24-slim is glibc, so DuckDB's musl build never loads.
 && rm -rf node_modules/oracledb/build node_modules/@duckdb/node-bindings-linux-*-musl \
 # Nothing executes these at run time: source maps, type declarations, TS sources,
 # docs, and exceljs's browser bundles (its Node entry is lib/). ~120 MB.
 && find node_modules -type f \( -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.md' \) -delete \
 && rm -rf node_modules/exceljs/dist node_modules/docx/dist/index.iife.js node_modules/docx/dist/index.umd.cjs \
 # DuckDB ships libduckdb.so with its symbol table (63 → 54 MB stripped); dynamic symbols stay.
 && strip --strip-unneeded node_modules/@duckdb/node-bindings-linux-*/libduckdb.so \
 && npm cache clean --force
# httpfs + aws for this stage's (the target's) platform; DuckDB verifies their signatures.
COPY --from=build /app/scripts/duckdb-extensions.js scripts/
RUN node scripts/duckdb-extensions.js /app/duckdb-extensions
# Every native file must be TARGETARCH's: exactly one DuckDB binding package,
# one extension platform directory, and each file's ELF e_machine (byte 18:
# 3e x86-64, b7 aarch64). A wrong-arch file would load nowhere but fail only
# at the first query — this fails the build instead.
RUN case "$TARGETARCH" in amd64) npm=x64 elf=3e ;; arm64) npm=arm64 elf=b7 ;; *) echo "unsupported TARGETARCH '$TARGETARCH'"; exit 1 ;; esac \
 && test "$(ls -d node_modules/@duckdb/node-bindings-linux-*)" = "node_modules/@duckdb/node-bindings-linux-$npm" \
 && test "$(ls -d /app/duckdb-extensions/*/*)" = "$(ls -d /app/duckdb-extensions/*/linux_$TARGETARCH)" \
 && for f in node_modules/@duckdb/node-bindings-linux-$npm/libduckdb.so /app/duckdb-extensions/*/linux_$TARGETARCH/httpfs.duckdb_extension /app/duckdb-extensions/*/linux_$TARGETARCH/aws.duckdb_extension; do \
      m=$(od -An -tx1 -j18 -N1 "$f" | tr -d ' '); echo "$f: e_machine $m"; test "$m" = "$elf" || { echo "wrong arch: $f is $m, want $elf for $TARGETARCH"; exit 1; }; \
    done

# ── runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    ORDINATE_ENV=prod \
    PORT=8080 \
    DATA_DIR=/data \
    DUCKDB_EXTENSION_DIR=/opt/ordinate/duckdb-extensions
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/package.json ./
# The server's compiled modules (+ the .sql migrations beside them), the few
# desktop-renderer files it still reads (until T8.1 moves them): five shared
# modules, the i18n catalogs, connector/agent logos and the published-site
# renderer; then assets (samples, geo) and the built web app.
COPY --from=build /app/src src
COPY --from=build /app/renderer/i18n renderer/i18n
COPY --from=build /app/renderer/hub/assets/connectors renderer/hub/assets/connectors
COPY --from=build /app/renderer/hub/assets/agents renderer/hub/assets/agents
COPY --from=build ["/app/renderer/hub/geoMatch.js", "/app/renderer/hub/geoCluster.js", "/app/renderer/hub/themeModel.js", "/app/renderer/hub/cardModel.js", "/app/renderer/hub/sizeLayout.js", "renderer/hub/"]
COPY --from=build /app/assets assets
COPY --from=build /app/web/dist web/dist
COPY --from=deps /app/duckdb-extensions /opt/ordinate/duckdb-extensions
# Fails the build if the server's module graph needs a file not copied above
# (every RPC handler module loads here, as at boot) or a pruned package no longer
# loads (connector drivers, exporters — oracledb without its thick binaries), then: non-root — the base
# image's `node` user (uid 1000) owns only the data volume.
RUN node -e "require('./src/server/app').registerHandlers(); for (const m of ['oracledb', 'tedious', 'mysql2', 'pg', 'exceljs', 'docx', 'chart.js']) require(m)" \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
# /readyz: DuckDB answers (and loads the S3 extensions in S3 mode) and Postgres pings.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server/main.js"]
