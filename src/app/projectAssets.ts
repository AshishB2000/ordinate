// Project ASSETS — the images an Image card shows. MAIN PROCESS.
//
// `projects/<id>/assets/<uuid>.<png|jpg|svg>`, so a project carries its own
// pictures (and deleting the project deletes them). A file is accepted by its
// BYTES, not its name: PNG and JPEG by magic number, SVG by its root element,
// and an SVG that carries script or event handlers is refused outright even
// though an <img> would not run it — the file outlives the tag it was added for.
// The renderer only ever receives a `data:` URL, never a path.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from './paths';
import { isValidId } from './ids';

export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export type AssetExt = 'png' | 'jpg' | 'svg';
const MIME: Record<AssetExt, string> = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };

export function sniffImage(buf: Buffer): AssetExt | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

/** An SVG that could do something when opened on its own. */
export function unsafeSvg(text: string): boolean {
  return /<script|<foreignObject|javascript:|\son[a-z]+\s*=|<iframe|<embed|<object/i.test(text);
}

/** Width / height from the header bytes, for the card's aspect lock. Null when unknown. */
export function imageSize(buf: Buffer, ext: AssetExt): { w: number; h: number } | null {
  if (ext === 'png' && buf.length >= 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (ext === 'jpg') {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) return null;
      const marker = buf[p + 1];
      const len = buf.readUInt16BE(p + 2);
      // SOF0..SOF15, less DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { w: buf.readUInt16BE(p + 7), h: buf.readUInt16BE(p + 5) };
      }
      p += 2 + len;
    }
    return null;
  }
  if (ext === 'svg') {
    const t = buf.toString('utf8', 0, Math.min(buf.length, 4096));
    const tag = /<svg[^>]*>/i.exec(t)?.[0] || '';
    const num = (k: string): number => Number((new RegExp(`\\s${k}\\s*=\\s*["']([\\d.]+)`, 'i').exec(tag) || [])[1]);
    const w = num('width');
    const h = num('height');
    if (w > 0 && h > 0) return { w, h };
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return { w: Number(vb[1]), h: Number(vb[2]) };
  }
  return null;
}

function assetsDir(projectId: string): string {
  return path.join(appPaths.userData(), 'projects', projectId, 'assets');
}

export interface StoredAsset { id: string; ext: AssetExt; aspect?: number }

/** Copy a picked file into the project, by content. */
export async function importImage(projectId: string, file: string): Promise<StoredAsset | { error: string }> {
  if (!isValidId(projectId)) return { error: 'No project is open.' };
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return { error: 'That file could not be read.' };
  if (stat.size > MAX_ASSET_BYTES) return { error: 'Images up to 5 MB can be added.' };
  const buf = await fs.promises.readFile(file);
  const ext = sniffImage(buf);
  if (!ext) return { error: 'Only PNG, JPG and SVG images can be added.' };
  if (ext === 'svg' && unsafeSvg(buf.toString('utf8'))) return { error: 'That SVG contains script, so it was not added.' };
  const id = randomUUID();
  const dir = assetsDir(projectId);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${id}.${ext}`);
  const tmp = dest + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, dest);
  const size = imageSize(buf, ext);
  return size && size.h > 0 ? { id, ext, aspect: size.w / size.h } : { id, ext };
}

/** The asset as a `data:` URL for an <img>, or null. */
export async function readImageDataUrl(projectId: string, id: string, ext: string): Promise<string | null> {
  if (!isValidId(projectId) || !isValidId(id) || !(ext in MIME)) return null;
  try {
    const buf = await fs.promises.readFile(path.join(assetsDir(projectId), `${id}.${ext}`));
    return `data:${MIME[ext as AssetExt]};base64,${buf.toString('base64')}`;
  } catch (_) {
    return null;
  }
}
