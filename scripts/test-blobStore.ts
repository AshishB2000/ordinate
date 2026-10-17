// Self-check for stored images (src/app/blobStore.ts, 0018_blobs.sql): logos
// and Image-card pictures, rows of `blobs` on a server with DATABASE_URL.
//
//  1. Which paths are stored images, and their caps (pure).
//  2. Server mode on files: the whitelist and the caps hold, exactly at the cap
//     is kept and one byte over is refused, and no refusal names a path.
//  3. Content is checked on every read: JPEG bytes at a .png path, a script SVG
//     and an SVG at a logo's .png name are served as missing — CONTROL: the
//     matching files are served.
//  4. With a database: the CHECK holds at 5 MiB; a file an earlier version left
//     on disk becomes the row on first read and survives its file — CONTROL: a
//     removed image stays gone until a file is planted again; a legacy file over
//     its cap is not served and makes no row; a project's range delete spares
//     its neighbours and other orgs; nothing is written to disk.
//
// The DB half needs a Postgres it may CREATE DATABASE on; without DATABASE_URL
// it prints one `skip` line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-blobStore.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, Pool } from 'pg';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-blobs-'));
const blobs: typeof import('../src/app/blobStore') = require('../src/app/blobStore');
const branding: typeof import('../src/app/branding') = require('../src/app/branding');
const assets: typeof import('../src/app/projectAssets') = require('../src/app/projectAssets');
const context: typeof import('../src/server/context') = require('../src/server/context');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');

const U = (): string => randomUUID();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1"/></svg>');
const SCRIPT_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const sized = (n: number): Buffer => Buffer.concat([PNG, Buffer.alloc(n - PNG.length)]);

function pure(): void {
  const p = U();
  const a = U();
  const yes = ['branding/logo.png', 'branding/logo.svg', `branding/dash-${U()}.png`, `branding/dash-${U()}.svg`,
    `projects/${p}/assets/${a}.png`, `projects/${p}/assets/${a}.jpg`, `projects/${p}/assets/${a}.svg`];
  const no = ['..', '../branding/logo.png', 'branding/../branding/logo.png', 'branding/logo.png.abc123.tmp', `projects/${p}/assets/${a}.png.0a1b.tmp`,
    'branding/logo.gif', 'branding/logo.jpg', 'branding/logo.PNG', `projects/${p}/assets/${a}.gif`, 'branding/dash-x.png', 'branding/other.png',
    `history/${Date.now()}/crop.png`, `projects/${p}/privacy/salt.key`, `projects/${p}/datasets/${a}.parquet`, `projects/x/assets/${a}.png`,
    `projects/${p}/assets/sub/${a}.png`, `projects/${p}/assets`, 'branding', 'config.json', `/branding/logo.png`];
  ok('isBlobPath: the two families are stored images', yes.every(blobs.isBlobPath), yes.filter((r) => !blobs.isBlobPath(r)).join());
  ok('isBlobPath: ..,  tmp files, other kinds, a crop.png, keys and directories are not', !no.some(blobs.isBlobPath), no.filter(blobs.isBlobPath).join());
  ok('capOf: a logo\'s cap is branding.LOGO_MAX_BYTES', blobs.capOf('branding/logo.png') === branding.LOGO_MAX_BYTES && blobs.capOf(`branding/dash-${U()}.svg`) === branding.LOGO_MAX_BYTES);
  ok('capOf: a picture\'s cap is projectAssets.MAX_ASSET_BYTES', blobs.capOf(`projects/${p}/assets/${a}.jpg`) === assets.MAX_ASSET_BYTES);
  ok('capOf: null for anything else', no.every((r) => blobs.capOf(r) === null));
  ok('validAsset: bytes that are their name', assets.validAsset(PNG, 'png') && assets.validAsset(JPG, 'jpg') && assets.validAsset(SVG, 'svg'));
  ok('validAsset: bytes that are not, or a script SVG', !assets.validAsset(JPG, 'png') && !assets.validAsset(PNG, 'svg') && !assets.validAsset(SCRIPT_SVG, 'svg') && !assets.validAsset(Buffer.from('hi'), 'png'));
}

const as = <T>(org: string, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: `${org}@t`, role: 'admin' }, org: { id: org } }, org, fn);
const threw = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try { await fn(); return null; } catch (err) { return (err as Error).message; }
};

/** Server mode, no database: the file, with the whitelist and caps. */
async function onFiles(): Promise<void> {
  await as('files', async () => {
    const ud = appPaths.userData();
    const pid = U();
    const at = (rel: string): string => path.join(ud, ...rel.split('/'));
    const logo = at('branding/logo.png');
    ok('cap: a logo of exactly 512 KiB is kept', (await threw(() => blobs.writeBlob(logo, sized(blobs.capOf('branding/logo.png')!)))) === null && fs.statSync(logo).size === 512 * 1024);
    const over = await threw(() => blobs.writeBlob(logo, sized(512 * 1024 + 1)));
    ok('cap: 512 KiB + 1 is refused, and the logo stays', over === 'That image is over the size limit for its kind.' && fs.statSync(logo).size === 512 * 1024, over);
    const pic = at(`projects/${pid}/assets/${U()}.png`);
    ok('cap: a picture of exactly 5 MiB is kept', (await threw(() => blobs.writeBlob(pic, sized(5 * 1024 * 1024)))) === null);
    const big = await threw(() => blobs.writeBlob(at(`projects/${pid}/assets/${U()}.png`), sized(5 * 1024 * 1024 + 1)));
    ok('cap: 5 MiB + 1 is refused', big === 'That image is over the size limit for its kind.', big);
    const refusals = [over, big,
      await threw(() => blobs.writeBlob(at('config.json'), PNG)),
      await threw(() => blobs.writeBlob(path.join(TMP, 'outside.png'), PNG)),
      await threw(() => blobs.writeBlob(at('branding/../branding/logo.gif'), PNG))];
    ok('whitelist: a settings file, a path outside userData and another kind are refused', refusals.slice(2).every((m) => m === 'Not a stored image path.'), refusals.join(' | '));
    ok('no refusal names DATA_DIR or any path', refusals.every((m) => !!m && !m.includes(TMP) && !m.includes('/') && !m.includes(path.sep)), refusals.join(' | '));
    ok('a refused path reads as missing, never from disk', (await blobs.readBlob(path.join(TMP, 'outside.png'))) === null);
    ok('files mode leaves no tmp sibling', fs.readdirSync(path.dirname(logo)).every((n) => !n.endsWith('.tmp')), fs.readdirSync(path.dirname(logo)).join());

    // 3. Content on every read.
    const id = (): string => U();
    const [aJpgAsPng, aPng, aScript, aSvg] = [id(), id(), id(), id()];
    await blobs.writeBlob(at(`projects/${pid}/assets/${aJpgAsPng}.png`), JPG);
    await blobs.writeBlob(at(`projects/${pid}/assets/${aPng}.png`), PNG);
    await blobs.writeBlob(at(`projects/${pid}/assets/${aScript}.svg`), SCRIPT_SVG);
    await blobs.writeBlob(at(`projects/${pid}/assets/${aSvg}.svg`), SVG);
    ok('content: JPEG bytes at a .png path are served as missing', (await assets.readImageDataUrl(pid, aJpgAsPng, 'png')) === null);
    ok('content: a script SVG is served as missing', (await assets.readImageDataUrl(pid, aScript, 'svg')) === null);
    ok('CONTROL: the matching PNG and SVG are served',
      (await assets.readImageDataUrl(pid, aPng, 'png')) === 'data:image/png;base64,' + PNG.toString('base64')
      && (await assets.readImageDataUrl(pid, aSvg, 'svg')) === 'data:image/svg+xml;base64,' + SVG.toString('base64'));
    await blobs.removeBlob(logo);
    await blobs.writeBlob(logo, SVG);
    ok('content: an SVG stored at the logo\'s .png name is served as missing', (await branding.readLogoDataUrl(ud, 'workspace')) === null);
    const saved = await branding.saveLogo(ud, 'workspace', PNG);
    ok('CONTROL: a saved PNG logo is served', saved.ok && (await branding.readLogoDataUrl(ud, 'workspace')) === 'data:image/png;base64,' + PNG.toString('base64'));
    await branding.saveLogo(ud, 'workspace', SVG);
    ok('png → svg: the PNG file is gone, the SVG served', !fs.existsSync(logo) && (await branding.readLogoDataUrl(ud, 'workspace'))?.startsWith('data:image/svg+xml') === true);
  });
}

async function withDb(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 4 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  try {
    await mig.migrate(pool);
    blobs.useBlobDb(pool);
    const rows = async (org: string): Promise<string[]> =>
      (await pool.query<{ path: string }>('SELECT path FROM blobs WHERE org_id = $1 ORDER BY path', [org])).rows.map((r) => r.path);

    const p = U();
    const a = U();
    const five = 5 * 1024 * 1024;
    const insert = (n: number): Promise<unknown> => pool.query('INSERT INTO blobs (org_id, path, bytes) VALUES ($1, $2, $3)', ['chk', `p${n}`, Buffer.alloc(n)]);
    const tooBig = await insert(five + 1).then(() => null, (err: { code?: string }) => err.code);
    ok('CHECK: 5 MiB + 1 bytes is refused by the table itself', tooBig === '23514', String(tooBig));
    ok('CHECK: exactly 5 MiB is accepted', await insert(five).then(() => true, () => false));

    await as('acme', async () => {
      const ud = appPaths.userData();
      const at = (rel: string): string => path.join(ud, ...rel.split('/'));
      const pic = at(`projects/${p}/assets/${a}.png`);
      await blobs.writeBlob(pic, PNG);
      ok('DB: a write is a row, and nothing on disk', (await rows('acme')).includes(`projects/${p}/assets/${a}.png`) && !fs.existsSync(pic));
      ok('DB: it reads back byte-equal', (await blobs.readBlob(pic))?.equals(PNG) === true);

      // A file an earlier version left on this pod's disk.
      const old = at('branding/logo.png');
      fs.mkdirSync(path.dirname(old), { recursive: true });
      fs.writeFileSync(old, PNG);
      ok('legacy: no row before the first read', !(await rows('acme')).includes('branding/logo.png'));
      ok('legacy: the first read serves the file', (await branding.readLogoDataUrl(ud, 'workspace')) === 'data:image/png;base64,' + PNG.toString('base64'));
      ok('legacy: …and made it the row', (await rows('acme')).includes('branding/logo.png'));
      fs.rmSync(old);
      ok('legacy: with the file deleted, the row still serves it', (await blobs.readBlob(old))?.equals(PNG) === true);
      await blobs.removeBlob(old);
      ok('removeBlob: no row, so it is missing', (await blobs.readBlob(old)) === null && !(await rows('acme')).includes('branding/logo.png'));
      fs.writeFileSync(old, PNG);
      ok('CONTROL: a file planted again is served again', (await branding.readLogoDataUrl(ud, 'workspace')) === 'data:image/png;base64,' + PNG.toString('base64'));
      await branding.removeLogo(ud, 'workspace');
      ok('removeLogo: the row and this pod\'s file are gone', !(await rows('acme')).some((r) => r.startsWith('branding/')) && !fs.existsSync(old));

      const bigFile = at(`branding/dash-${U()}.png`);
      fs.writeFileSync(bigFile, sized(512 * 1024 + 1));
      ok('legacy over its cap: not served', (await blobs.readBlob(bigFile)) === null);
      ok('legacy over its cap: no row', !(await rows('acme')).some((r) => r.startsWith('branding/dash-')));

      // listBlobs: rows and whitelisted disk names, sorted.
      const dir = at(`projects/${p}/assets`);
      const diskOnly = U();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${diskOnly}.svg`), SVG);
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
      const listed = await blobs.listBlobs(dir);
      ok('listBlobs: the row and the disk picture, sorted, not the stray file', JSON.stringify(listed) === JSON.stringify([`${a}.png`, `${diskOnly}.svg`].sort()), listed.join());
      fs.rmSync(dir, { recursive: true, force: true });

      // The range delete.
      const neighbours = [`projects/${p}x/assets/${a}.png`, `projects/${p}-/assets/${a}.png`, `projects/${p}0`, `projects/${p}`];
      for (const n of neighbours) await pool.query('INSERT INTO blobs (org_id, path, bytes) VALUES ($1, $2, $3)', ['acme', n, PNG]);
      await blobs.writeBlob(at(`projects/${p}/assets/${U()}.svg`), SVG);
      await as('other', () => blobs.writeBlob(path.join(appPaths.userData(), 'projects', p, 'assets', `${a}.png`), PNG));
      const gone = await blobs.removeBlobsUnder(at(`projects/${p}`));
      const left = await rows('acme');
      ok(`removeBlobsUnder: the project's ${gone} pictures go`, gone === 2 && !left.some((r) => r.startsWith(`projects/${p}/`)), left.join());
      ok('removeBlobsUnder: projects/<p>x…, <p>-…, <p>0 and <p> itself are spared', neighbours.every((n) => left.includes(n)), left.join());
      ok('removeBlobsUnder: another org\'s same path is spared', (await rows('other')).length === 1);
    });
  } finally {
    blobs.useBlobDb(null);
    await pool.end();
  }
}

(async () => {
  pure();
  context.enterServerMode(TMP);
  await onFiles();
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_blobs_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  try {
    await withDb(u.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
