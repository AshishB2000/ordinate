// Project BOUNDARIES — imported GeoJSON a choropleth can use beside the bundled
// geographies. MAIN PROCESS.
//
// `projects/<id>/boundaries/<uuid>.json` holds the REBUILT collection
// (analysis/geojsonCheck.ts) plus its name, properties and bbox; the file the
// user picked is read once and never referenced again.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { isValidId } from './ids';
import { checkBoundaries, MAX_BOUNDARY_BYTES } from '../analysis/geojsonCheck';
import type { BoundaryCheck } from '../analysis/geojsonCheck';
import * as queryCache from '../engine/queryCache';

export interface BoundaryMeta {
  id: string;
  name: string;
  featureCount: number;
  properties: BoundaryCheck['properties'];
  bbox: BoundaryCheck['bbox'];
}

function dir(projectId: string): string {
  return path.join(app.getPath('userData'), 'projects', projectId, 'boundaries');
}

/** Validate `text` and store it as a boundary set named `name`. */
export async function importBoundaryText(projectId: string, name: string, text: string): Promise<BoundaryMeta | { error: string }> {
  if (!isValidId(projectId)) return { error: 'No project is open.' };
  const res = checkBoundaries(text);
  if (!res.ok) return { error: res.error };
  const meta: BoundaryMeta = {
    id: randomUUID(),
    name: String(name || 'Boundaries').slice(0, 80),
    featureCount: res.collection.features.length,
    properties: res.properties,
    bbox: res.bbox,
  };
  await fs.promises.mkdir(dir(projectId), { recursive: true });
  const file = path.join(dir(projectId), meta.id + '.json');
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify({ meta, collection: res.collection }), 'utf8');
  await fs.promises.rename(tmp, file);
  queryCache.invalidateProject(projectId); // a map may resolve regions through these
  return meta;
}

export async function importBoundaryFile(projectId: string, file: string): Promise<BoundaryMeta | { error: string }> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return { error: 'That file could not be read.' };
  if (stat.size > MAX_BOUNDARY_BYTES) return { error: 'Boundary files up to 15 MB can be imported.' };
  const name = path.basename(file).replace(/\.(geo)?json$/i, '');
  return importBoundaryText(projectId, name, await fs.promises.readFile(file, 'utf8'));
}

async function readOne(projectId: string, id: string): Promise<any> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  try {
    return JSON.parse(await fs.promises.readFile(path.join(dir(projectId), id + '.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

export async function listBoundaries(projectId: string): Promise<BoundaryMeta[]> {
  if (!isValidId(projectId)) return [];
  const names = await fs.promises.readdir(dir(projectId)).catch(() => [] as string[]);
  const out: BoundaryMeta[] = [];
  for (const n of names) {
    const id = n.replace(/\.json$/, '');
    if (!n.endsWith('.json') || !isValidId(id)) continue;
    const rec = await readOne(projectId, id);
    if (rec && rec.meta) out.push(rec.meta);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The stored collection, with each feature's `name` set from the join property for the map's matcher. */
export async function getBoundary(projectId: string, id: string, property?: string): Promise<any> {
  const rec = await readOne(projectId, id);
  if (!rec || !rec.collection) return null;
  if (!property) return rec.collection;
  return {
    type: 'FeatureCollection',
    features: rec.collection.features.map((f: any) => ({
      ...f,
      properties: { ...f.properties, name: f.properties[property] === undefined ? '' : String(f.properties[property]) },
    })),
  };
}
