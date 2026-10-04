// A map as a PNG for a report page — the web replacement for the desktop's
// captureMapPNG, which snapshotted the COMPOSITED window (webContents.
// capturePage) because MapLibre draws into one WebGL canvas while value labels
// and cluster counts are DOM markers beside it. A browser has no capturePage,
// so: draw the ordinary <MapView> off-screen in the print theme, wait for its
// first idle, copy the WebGL canvas (created with preserveDrawingBuffer) onto
// the page surface, then paint every DOM marker onto the same canvas at its
// laid-out position, in its own computed colours and font.
//
// ponytail: the legend and notes (MapOverlays) are not composited — the
// caption under the picture names the measure; composite them the same way if
// a reader needs the scale in the file.

import { createRoot } from 'react-dom/client';
import { MapView } from '../../../charts/maps/MapView';
import type { MapData } from '../../../charts/maps/types';
import p from './Print.module.css';

const MARKERS = '.cv-map-value-label, .cv-map-cluster';
const IDLE_MS = 12_000;

function waitIdle(wrapHost: HTMLElement): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = () => {
      const wrap = wrapHost.querySelector<HTMLElement>('[data-map-status]');
      const status = wrap?.dataset.mapStatus;
      if (wrap && status && status !== 'loading' && wrap.getAttribute('aria-busy') === 'false') return resolve(status === 'ready' ? wrap : null);
      if (performance.now() - started > IDLE_MS) return resolve(null);
      setTimeout(tick, 60);
    };
    tick();
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Paint the DOM markers over the map picture, scaled from CSS px to the canvas's pixels. */
export function compositeMarkers(ctx: CanvasRenderingContext2D, wrap: HTMLElement, scale: number): number {
  const origin = wrap.getBoundingClientRect();
  let n = 0;
  for (const el of wrap.querySelectorAll<HTMLElement>(MARKERS)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    const x = (r.left - origin.left) * scale;
    const y = (r.top - origin.top) * scale;
    const w = r.width * scale;
    const h = r.height * scale;
    const radius = Math.min(h / 2, (parseFloat(cs.borderTopLeftRadius) || 0) * scale);
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      ctx.fillStyle = cs.backgroundColor;
      roundRect(ctx, x, y, w, h, radius);
      ctx.fill();
    }
    const bw = parseFloat(cs.borderTopWidth) || 0;
    if (bw > 0) {
      ctx.strokeStyle = cs.borderTopColor;
      ctx.lineWidth = bw * scale;
      roundRect(ctx, x, y, w, h, radius);
      ctx.stroke();
    }
    ctx.fillStyle = cs.color;
    ctx.font = `${cs.fontWeight} ${(parseFloat(cs.fontSize) || 11) * scale}px ${cs.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(el.textContent || '', x + w / 2, y + h / 2);
    n++;
  }
  return n;
}

/** True when the picture is one flat colour — a GL layer that never made it into the read. */
function uniform(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  const step = Math.max(4, Math.floor(d.length / 4 / 1024) * 4);
  for (let i = step; i < d.length; i += step) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
  return true;
}

export async function renderMapPng(type: string, data: MapData, { width, height, projectId }: { width: number; height: number; projectId: string }): Promise<string | null> {
  const host = document.createElement('div');
  host.className = `${p.light} ${p.mapHost}`;
  host.style.width = `${Math.round(width)}px`;
  host.style.height = `${Math.round(height)}px`;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    root.render(<MapView data={data} chartType={type} label="Map" projectId={projectId} />);
    const wrap = await waitIdle(host);
    const gl = wrap?.querySelector<HTMLCanvasElement>('canvas.maplibregl-canvas');
    if (!wrap || !gl || !gl.width) return null;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = document.createElement('canvas');
    out.width = gl.width;
    out.height = gl.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = getComputedStyle(host).getPropertyValue('--surface').trim() || '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(gl, 0, 0);
    if (uniform(ctx, out.width, out.height)) return null;
    compositeMarkers(ctx, wrap, gl.width / Math.max(1, gl.getBoundingClientRect().width));
    return out.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    root.unmount();
    host.remove();
  }
}
