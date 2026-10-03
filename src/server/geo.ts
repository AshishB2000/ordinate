// The bundled boundary GeoJSON (assets/geo, fetched by postinstall) for the web
// maps — what `geo:load` and the `geo` lazy bundle gave the desktop hub.
//
// The shapes are public-domain and the same for every org, so they cache hard:
//   GET /api/geo/index.json            → { level: url } — revalidated (no-cache)
//   GET /api/geo/<level>.<hash>.json   → the FeatureCollection — immutable
// The hash is the file's own content hash, so a server shipping new shapes
// serves new URLs and no browser keeps an old file. Behind sign-in like every
// /api/ route (any member; no org path is involved).
//
// No request path ever reaches the filesystem: three fixed files are read once
// per process and a request is answered by exact NAME lookup in that map, so
// `..`, encoded slashes and absolute paths are just names that are not in it.

import * as crypto from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as zlib from 'zlib';
import type { FastifyInstance } from 'fastify';

export const GEO_DIR = path.join(__dirname, '..', '..', 'assets', 'geo');

/** Level → bundled file. The two `.js` files are `window.__GEO_X__ = {…};` scripts. */
const FILES: Readonly<Record<string, string>> = {
  country: 'world-countries.js',
  us_state: 'us-states.js',
  us_county: 'us-counties.json',
};

interface Entry {
  readonly body: Buffer;
  readonly gzip: Buffer;
}
interface Geo {
  readonly index: Record<string, string>;
  readonly byName: ReadonlyMap<string, Entry>;
}

const gzip = promisify(zlib.gzip);

/** The JSON inside a `window.__GEO_X__ = {…};` script, or the file itself. Throws if it is not JSON. */
export function geoJsonText(file: string, text: string): string {
  const json = file.endsWith('.js') ? text.replace(/^[\s\S]*?window\.__GEO_[A-Z_]+__\s*=\s*/, '').replace(/;\s*$/, '') : text;
  JSON.parse(json); // a truncated download must 404, not reach MapLibre
  return json;
}

async function load(dir: string): Promise<Geo> {
  const index: Record<string, string> = {};
  const byName = new Map<string, Entry>();
  for (const [level, file] of Object.entries(FILES)) {
    let json: string;
    try {
      json = geoJsonText(file, await fsp.readFile(path.join(dir, file), 'utf8'));
    } catch {
      continue; // postinstall never fetched it: the level is absent and its maps fall back
    }
    const body = Buffer.from(json, 'utf8');
    const name = `${level}.${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`;
    byName.set(name, { body, gzip: await gzip(body, { level: 9 }) });
    index[level] = `/api/geo/${name}`;
  }
  return { index, byName };
}

export function registerGeoRoutes(app: FastifyInstance, dir: string = GEO_DIR): void {
  // ponytail: loaded once per process (≈2.2 MB raw + ≈0.6 MB gzip held); a
  // deploy restarts the pod, which is the only time the files change.
  let geo: Promise<Geo> | null = null;
  const loaded = (): Promise<Geo> => (geo ??= load(dir));

  app.get('/api/geo/index.json', async (_req, reply) => {
    const { index } = await loaded();
    return reply.header('Cache-Control', 'no-cache').send(index);
  });

  app.get<{ Params: { name: string } }>('/api/geo/:name', async (req, reply) => {
    const entry = (await loaded()).byName.get(req.params.name);
    if (!entry) return reply.code(404).send({ error: 'not found' });
    reply
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Vary', 'Accept-Encoding')
      .type('application/json');
    // ponytail: gzip only (no @fastify/compress, plan §2); an ingress usually compresses anyway.
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      return reply.header('Content-Encoding', 'gzip').send(entry.gzip);
    }
    return reply.send(entry.body);
  });
}
