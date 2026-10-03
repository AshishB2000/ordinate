// Install the DuckDB extensions S3 storage needs (httpfs, aws) into a
// directory — once, at BUILD time. The server only ever LOADs them
// (src/engine/storage.ts workerSetup sets autoinstall off); point it here with
// DUCKDB_EXTENSION_DIR. The Docker image (T7.1) runs this into its own
// directory; locally the S3 self-checks use the repo's `.duckdb-extensions/`.
// Downloads from extensions.duckdb.org, signed — DuckDB verifies the signature.
//
//   npm run build:ts && node scripts/duckdb-extensions.js [dir]

export {}; // module scope — sibling scripts share top-level names
const path: typeof import('path') = require('path');
const { DuckDBInstance }: typeof import('@duckdb/node-api') = require('@duckdb/node-api');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', '.duckdb-extensions'));

(async () => {
  const c = await (await DuckDBInstance.create(':memory:', { extension_directory: dir })).connect();
  for (const ext of ['httpfs', 'aws']) await c.runAndReadAll(`INSTALL ${ext};`);
  const rows = (await c.runAndReadAll(
    "SELECT extension_name, extension_version FROM duckdb_extensions() WHERE extension_name IN ('httpfs', 'aws') AND installed",
  )).getRowObjectsJson();
  console.log(`installed into ${dir}: ${rows.map((r) => `${r.extension_name} ${r.extension_version}`).join(', ')}`);
  if (rows.length !== 2) process.exitCode = 1;
})().catch((err: unknown) => {
  console.error(`duckdb-extensions: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
