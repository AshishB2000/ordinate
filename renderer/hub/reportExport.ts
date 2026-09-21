// Report export — chart→PNG capture, the capture export dialog, and the
// standalone HTML/PNG one-pager. Classic script sharing global scope with
// hub.js: buildChart, window.hub.save* and the vendor globals all resolve at
// call time.
//
// The three DOCUMENT writers used to live here too. They moved to
// reportWriters.ts when they were generalised from "one capture, one page" to
// "any Report's page list" and this file went past the 800-line cap
// (.claude/rules/file-size.md). One set of writers, still — a capture report is
// now a Report whose page list holds a single Tile page, which is exactly what
// stops the capture export drifting away from the dashboard report. Three
// files, three jobs:
//
//   reportExport.ts   capture a chart or a map to a PNG; the export dialog.
//   reportRender.ts   a Report's pages → `RenderedPage`s → `reportPageBlocks`;
//                     the builder's live preview reads the same blocks.
//   reportWriters.ts  blocks → PDF / PPTX / DOCX bytes.

// How a caller wants a capture FRAMED.
//
// `themeClasses` is the load-bearing field. A chart reads its colours off the
// element it is drawn into (chartPalette.getCSSVar takes an `el`), and the
// holders below hang off <body> — so a capture inherited the APP theme, which is
// how a dark-mode app pasted dark chart rectangles onto a light export sheet.
// The DASHBOARD's own `dash-theme--* / dash-density--* / dash-accent--*` classes
// on the holder re-point every one of those reads at the style the export is
// rendered under. Omitting the field is the report path, which genuinely wants
// the app theme and the fixed holder box. `width`/`height` are LOGICAL pixels:
// capturing at the destination box is what stops a chart being letterboxed.
interface CaptureFrame { themeClasses?: string[]; width?: number; height?: number }

/** Put a frame's theme classes on a capture holder. No frame → the app theme. */
function applyCaptureFrame(holder: HTMLElement, frame?: CaptureFrame): void {
  if (!frame || !Array.isArray(frame.themeClasses)) return;
  frame.themeClasses.forEach((c) => { if (c) holder.classList.add(c); });
}

// ── Report export (stage 1: chart→PNG + dialog; file generation is next stage) ──
// Render `type` to a crisp PNG data URL OFF-SCREEN (2x, no animation), composited
// onto a solid background so it embeds cleanly in a report. Reuses buildChart, so
// the exported chart matches the on-screen one. Resolves null if the type can't draw.
// Maps are NOT handled here — see captureMapPNG below, which snapshots the live
// MapLibre render through the main process instead of rasterizing a Chart.js canvas.
function captureChartPNG(
  type: string, data: any, overrides?: any, frame?: CaptureFrame,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const holder = document.createElement('div');
    holder.className = 'export-capture-holder';
    applyCaptureFrame(holder, frame);
    // The CSS box (1100x620) is the default; a framed capture overrides it so the
    // PNG carries the aspect ratio of the card it is going into. devicePixelRatio: 2
    // below then makes it 2x that box in real pixels, whatever the display is.
    if (frame && frame.width) holder.style.width = Math.max(200, Math.round(frame.width)) + 'px';
    if (frame && frame.height) holder.style.height = Math.max(120, Math.round(frame.height)) + 'px';
    const canvas = document.createElement('canvas');
    holder.appendChild(canvas);
    document.body.appendChild(holder);
    let chart: any = null;
    const finish = (url: string | null) => {
      if (chart) { try { chart.destroy(); } catch (_) {} }
      holder.remove();
      resolve(url);
    };
    try {
      chart = buildChart(canvas, data, type, Object.assign({}, overrides, { noAnimate: true, devicePixelRatio: 2 }));
      if (!chart) return finish(null);
      chart.update('none'); // force the final, animation-free frame before we read pixels
      requestAnimationFrame(() => {
        try {
          const src = chart.canvas;
          const out = document.createElement('canvas');
          out.width = src.width; out.height = src.height;
          const ctx = out.getContext('2d')!;
          // Solid background = the theme surface, read off the HOLDER so a framed
          // capture gets the EXPORT's surface rather than the app's. The root read
          // this replaces is what backed a light-sheet chart with a dark rectangle.
          ctx.fillStyle = getCSSVar('--surface', holder) || '#ffffff';
          ctx.fillRect(0, 0, out.width, out.height);
          ctx.drawImage(src, 0, 0);
          finish(out.toDataURL('image/png'));
        } catch (_) { finish(null); }
      });
    } catch (_) { finish(null); }
  });
}

// ── MapLibre map → PNG ───────────────────────────────────────────────────────
//
// PHASE-4 CONTRACT — the two export hooks renderer/hub/mapRender.ts publishes:
//   • `getMapInContainer(container)` → the live MapLibre map drawn into that container,
//     or null when a geo fallback (bar chart / note) drew instead.
//   • `waitForMapIdle(container, timeoutMs)` → true once the map has loaded its tiles
//     and settled on 'idle', false on timeout. This replaces the Leaflet-era DOM
//     tile-counting wait: MapLibre knows when it is done, the DOM does not.
// mapRender.ts also owns `preserveDrawingBuffer: true` on the map — needed ONLY by the
// last-resort canvas fallback below, never by capturePage. It is set in exactly one
// place, there, and is not duplicated here.
//
// WHY capturePage AND NOT `canvas.toDataURL()` as the primary. MapLibre draws the whole
// map (tiles, fills, circles, labels) into ONE WebGL canvas, but the legend, the
// "couldn't place" note and the value chips are DOM siblings — reading the canvas alone
// would silently drop them. `webContents.capturePage` snapshots the COMPOSITED page, so
// WebGL layers and DOM overlays come back in one image, at the display's scale factor,
// with no CORS/canvas tainting and no new dependency. It also does NOT depend on
// preserveDrawingBuffer, because the compositor reads the presented surface rather than
// the drawing buffer. The canvas read is kept only as a degraded fallback.
//
// The holder is `position: fixed` at the hub's top-left (.export-map-capture), i.e. it
// is genuinely on-screen in the VISIBLE hub window while the snapshot is taken — the
// offscreen report window (src/reportCapture.ts) never renders a map itself, it only
// embeds the `data:` PNG produced here. That is deliberate: it keeps WebGL entirely out
// of the hidden-BrowserWindow path.
//
// Returns null if the map can't be captured cleanly (never idles, comes back blank, IPC
// failure) so the caller falls back rather than embedding a half-drawn map.
async function captureMapPNG(vizData: any, type: string, frame?: CaptureFrame): Promise<string | null> {
  if (!window.hub || typeof window.hub.captureRegion !== 'function') return null;
  if (typeof renderMapInArea !== 'function') return null;

  const holder = document.createElement('div');
  holder.className = 'export-map-capture';
  // Same theme rule as captureChartPNG: mapRender resolves --accent / --surface-3 /
  // --border off elements INSIDE this holder, so these classes are what decide
  // whether the choropleth comes back light or dark.
  applyCaptureFrame(holder, frame);
  // Generous capture size (clamped to the window) → crisp at the display's pixel ratio.
  // A frame asks for the destination card's proportions instead; the window clamp
  // stays either way, because capturePage can only read pixels that are on screen.
  const W = Math.min(960, Math.max(480, Math.min((frame && frame.width) || 960, window.innerWidth - 40)));
  const H = Math.min(600, Math.max(320, Math.min((frame && frame.height) || 600, window.innerHeight - 40)));
  holder.style.width = W + 'px';
  holder.style.height = H + 'px';
  document.body.appendChild(holder);

  try {
    await renderMapInArea(holder, vizData, type);
    // Drop the interactive controls — the Values / ⋯ cluster and MapLibre's own
    // zoom/compass buttons. The value legend and the OSM attribution both stay.
    holder.querySelectorAll<HTMLElement>('.cv-graph-controls, .maplibregl-ctrl-group')
      .forEach(c => { c.style.display = 'none'; });

    const map = getMapInContainer(holder);
    if (!map) return null;   // a geo fallback (bar chart / note) drew instead of a map

    // The holder was sized before the map was built, but a resize() is free insurance
    // that the GL drawing buffer matches the box we are about to snapshot.
    try { if (typeof map.resize === 'function') map.resize(); } catch (_) {}

    const idle = await waitForMapIdle(holder, 8000);
    if (!idle) return null;
    // Two frames so the last render pass is composited before the snapshot is taken.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const rect = holder.getBoundingClientRect();
    const png = await window.hub.captureRegion({
      x: rect.left, y: rect.top, width: rect.width, height: rect.height,
    });
    // A uniform image means the WebGL layer did not make it into the composite — the
    // one failure mode that would otherwise ship a blank rectangle into a report.
    if (png && !(await isUniformImage(png))) return png;
    return await captureMapCanvasPNG(map, holder);
  } catch (e) {
    console.error('[export] map capture failed', e);
    return null;
  } finally {
    if (typeof destroyMapInContainer === 'function') { try { destroyMapInContainer(holder); } catch (_) {} }
    holder.remove();
  }
}

// Last resort when the composited snapshot came back blank: read the map's own WebGL
// canvas. Loses the DOM legend/notes, but a map without its legend beats no map at all.
// This is the ONE caller that needs the map to have been created with
// preserveDrawingBuffer: true (set in mapRender.ts, see the contract above) — without
// it the read comes back transparent, which the uniform check below rejects, and the
// caller degrades to "couldn't capture the map" rather than embedding a blank box.
async function captureMapCanvasPNG(map: any, holder?: HTMLElement): Promise<string | null> {
  try {
    const canvas = typeof map.getCanvas === 'function' ? map.getCanvas() : null;
    if (!canvas || typeof canvas.toDataURL !== 'function') return null;
    if (typeof map.triggerRepaint === 'function') map.triggerRepaint();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Composite onto the theme surface so a transparent GL background doesn't turn into
    // a black block in a PDF/Word page.
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = getCSSVar('--surface', holder) || '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    const url = out.toDataURL('image/png');
    return (await isUniformImage(url)) ? null : url;
  } catch (e) {
    console.error('[export] map canvas fallback failed', e);
    return null;
  }
}

// True when every pixel of `dataUrl` is the same colour — the signature of a capture
// that produced nothing (blank GL layer, empty surface). Sampled through a small
// downscale so the check costs a fixed ~1k pixel reads regardless of capture size.
// Errors resolve false: a check we can't run must never discard a good image.
function isUniformImage(dataUrl: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const img = new Image();
      img.onerror = () => resolve(false);
      img.onload = () => {
        try {
          const S = 32;
          const c = document.createElement('canvas');
          c.width = S; c.height = S;
          const ctx = c.getContext('2d');
          if (!ctx) return resolve(false);
          ctx.drawImage(img, 0, 0, S, S);
          const d = ctx.getImageData(0, 0, S, S).data;
          for (let i = 4; i < d.length; i += 4) {
            if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) {
              return resolve(false);
            }
          }
          resolve(true);
        } catch (_) { resolve(false); }
      };
      img.src = dataUrl;
    } catch (_) { resolve(false); }
  });
}

let _exportEscape: ((e: KeyboardEvent) => void) | null = null;
let _exportA11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
function closeExportDialog(): void {
  const ov = document.getElementById('export-overlay');
  if (ov) ov.remove();
  if (_exportEscape) { document.removeEventListener('keydown', _exportEscape, true); _exportEscape = null; }
  if (_exportA11y) { _exportA11y.release(); _exportA11y = null; } // return focus to the trigger
}

// A filesystem-safe default filename from the capture title, for a given extension.
function reportFilename(title: string | null | undefined, ext: string): string {
  const base = String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return (base || 'screenchart-report') + '.' + ext;
}


// The app's brand mark, inlined as a PNG data URL. Inlined because assets/
// icons is excluded from the packaged asar (see package.json build.files), so
// the report paths cannot read it off disk. A PNG rather than the SVG the
// exporters used to rasterize: pdfmake, pptxgenjs and docx all take a raster
// data URL directly, which deleted the canvas round-trip entirely.
const REPORT_LOGO_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAYAAACLz2ctAAA3tElEQVR42u2dB3yUVdb/J8nU9E4SQgtVUFEUkV7SA6G7rIoIhJBeKdIJJXQLKJZd3VVULK+67f9+3vddKyBFQJEuIJZ11VVXVikpM8/znP85597nmQmJu4TXl0XnOZ/P7/PMDJPJZObLOfece+69FotppplmmmmmmWaaaaaZZppppplmmmmmmWaaaaaZZppppplmmmmmmWaaaaaZZppppplmmmmmmWaaaaaZZppppplmmmmmmWaaaaaZZpppppn2b7DO34T1/U1jauYzjZNIA5/0ZFjm1IWbH4xp/6d2+8ue+ZWvqpD5lAp9HlGh5yYVrtmoQi+8pv9GgaI/uvd2efzsIPOTMu1Hs6mvuEemPu6pGfGE+lXfRwFufgTg1kc06LtZgxsf1KD3Rg2ue0CD7hs06LRWha7rVRiw2QPDHm149OYn6lPMT9C0y7JJr6i3jtmqQud1KvR+QIWbH1Kh70MEHkL4EECfB4Hhu/5+Da69D73hBhV6rNXgmjUa9ER1rVWh+2oFSv6fBywF9R3NT9S0S7ZBWxtyhmNI7YxQXY9e7noMszdsQo/3EAnQ8yF8mwCuR893LQLY6z4EDz1g93UohLD7GoRxtQrdVmvQYTmCiBAXvqDONT9Z0/65FfyjY+l/uj/tusEDndYp0P1+BOle9G54vY68Har3JroChl1A+ADhAwHgeg26YQgmdUUAu67SoPNKoXaojqsQwj9pL5kfsmnN7M5XYODQR9SXeiFo7RCeLgQQeq1u6AG7o64hCDHMEmjXcsgVXq/XvUI9NwACCAgfhl4Mv13Q86VgCO5E4K3AsWENekJU4lL0oPT8tepLRS+oaeYn7+fW7Wl3v5I/CNg607gNwem6Vly7EICo7uvRE64XnpDCbM97RbhlrZdaBxx++edQndH7pTB8KnTEENwJweu0FK9L8PcgiCnL8XkrVSh4SXnF/Bb81Er+qORfv0mFDrUI0L3ovdYAey9SN5IBoPCCPRC4HghbD/R2PdYLj9djndRa8TNdMMySOqP3YwCXawLAZQgdgtcZQeyK124EIXrGlEUqDH9YgYnPuSvMb8SPbNpLyoM33a9AL4Srl8xeKXnQx290pcShuw7gegnfOnmV8HVfq0sA2JUArBUA0tgvheDTAUSR9+tSg78D1X0ZCj1kyhIPdF5cD+OfbtxifjM/57LKf6gTej+gvn7zRhEieyAwBJ6AD6Fg+BRxlclEdwmmDloPn9vd1wivKaRx0tEVvWmXWpF4sIdbLtSJtAxYuifsvJTgQy1WoONCBZIXeGDQAx5ov9LzYMmfPIXmN/ZzsfvrO1a+qp5PRDBSaHy2WoRKgkZ4Lp/M1ZAmEwofyFYDl1X4ukqoq1QXUq0QZ74E3woQ4FEYXkZJCECHpUIdl6AWY3a8AMGbr0DSPAUS5qoQP0eF8NkquCoVGPSIss388n7ilvcn95abHlIhFsNgSq1IDDpTmJQ1Or1s0s3wgE0h5KTEV6u8nq4rwqZfGT4JXmfD8wGD11FmwO3R67VbIkXwLVShLcKXSPDdo0A8AhhbpUJMNQpBDMHbY3+jwC0PekaY3+RP0EY/rf4+Bgf5SQRBrcoJAQNYKxIFAoq8X1dZOhHlEwFnZ5lMdJEhlZ9f6wPeShDgrRQyvN4yjcd7LPZ4CB+G2fYoAi95MUKH76ntAnxfCwg8FdrMRfjmKBCLni+mSoFoghAVWa2Bo0SDaASy6neqarGsDjC/1avcin+vTOv+gPrg8MfQ4xAQtSIEdlgh63E0PqsVY8Auq0TJRGSu4rHOtXoG6xV7NQSsywopCV2XFcD3O+vjvGWi3tfU46mQTJLgJS3UEDwNEuerkDAP4btHZfji0OPFziLvRwAKCGMrNIiq1CAcb4dUUClH/br3OrVm8lZ1qPlNX4WW+VjjS20XKezlusostBMCxOCtkEAxYDqAICDUoeTEQeXndlruI8xW9WQiRc9mpVJkeYXqfB1R7ZcI6NoZ0OH4DhOMRAy3iQyeBgmkeZqAT4774tH7xaFiq2UIRuiiK9ELIngR5UJ0O6RIheAiN0x8vB56rzbnl68KS1x+4aaZL7ihc40C3RGyruStlosstKMEKkUHcKUXNsOTyeky+rdOBKsEr+MyAZ9X5N1U9nIkAi9lqSaLzBRqMcSilyNxmCXwKMySt1sgANThS7hHAkjwzdH4GofX2FkaQ0geMBIBDEfwwstQpegJS/CKAIai7NM8MGBNI1gmnmlvEvDvsoL6yPLfeep71HoQBgV60jgNAWIAdaBWqoZS5GO6OvPYDYWhNGWFDp8oHBN8BFtHfN0OeO2wVGqJUEdDGqvDYpFYtF1IYZbGd0IJmGQkzJMQGp5Paq4m4UPN1tADCgBjcOxHAEYQgOj1whDCMIQwFAEMKxYQRpUoEF6M3n6hGwpfcL9twnAF7Y5XPEPTfqXU3HivcqYrgtUTwyip+0qZMPgAmOIDIAPGsEktF+q0XNTnOGOVXo7Aa79UkcmDIsLqYrxPQu/WYaEU3m6P13bo3SixoLEda56QPs6ja4KEjjVHKH42sOJmAXo+CR8qqkpDADUBoA+EEaUIHyoaYYzF+3HlQl3x/Q24V9nSb31DZ5OQ/6tQu8GdOO1ZgsLDkFxDxeSVQt0RqK4MlAyhMvRyCOYEQXi1DjJJEAIhqsvJMZw3Y1U4lLI3WyjGcXrmmoxXKqEkE1izFVYS3k6aJ8d0qDh9bDeXslx8HkKXQNDhOI8Uj56OFFeN8BF4VeT1NB73kSj5iERFVAgvGF6u4DhQgUhUjASvDSoRlYT3k/Bn4tFrtsUEpuxFD1hu+KqNScyPap+6sh9Wvmm3gOp3qBXk8QC6kSR8nZeDN4RKUS9eB/ZsqpGZdjAEfL+9TB5oDEfwtcfkoZ0cx9EYLlF6NgqpFGLbzFc5U+25yA39ahvhuiVuaDNLQWjw3+aocjwn4eMyi4DPAHCWF8DYKqGYSoJPZL1CYgxIAOoQEnxRBKD0em3wsQQW/ieoxPdJmTP+TFgB/ied74GC5xrzTW5+BJv2rPvXN29AD1QjQitln12W6WUQAZ4eTqnWJ6AT4LVn8BAqCV/7xSQEb4lQu0U0dlMNcQKxUCiJSyUKQiTHcQsoW/XA9asUqPyT4kl/+EJf8Q6/CbvjOfWejM0UJhESqundI2Y2yPsRlKQECV+bauGt4mS9L0b3erLsQtdIIwMWni+iQni/aHwsBhWHisfnxpPn49sKXwlOKts4yxB4/E8x5Vn3RpOgy7BBGxu6Dtnoefz6WjFLQKB0lNkmz6XKLNS37mZ4NgM41fB4XB5B8HyVvEhjtV0olCSz1DYUSmWJJBbBiZ4jQmqfderByj+qi7v/Edq29J5veNQTWfmSOh+Toef6rhGAeb0fAahBInq9BAy5bao0Bog8FkEVxR5OKMIXvHJVhl58Trl4bjQCGkMqF7XCWLqWC/iiSvFnMEGJoGSlUMGM2QO9ltIwwf1U/pONqSZZ/8JcleevK36hAb98D0TOpvKFgIIKuMmLZajk8ZoqwVKb1N3Yiy3WpHxvC7VdBCgCDgzokmSI5QxVjt9i0ItFzBaD/+yHVRj5hHtKa/+W8ZvVP8agJ4oqR/DwNRMRwCQEMBEBTETwEhDAuErh0aIJHvSeEWUCvHD9NiUeZaoEULxWVNkPCJOTcJkphyJ8YSQMxxEEYgl5WQVKXvK8Z1L2Q1WVrY0zEue6wV6ssNeJQe8RR1AQhAu8EBJkYqym8Vit3SJZf6PEQPdqLNVH8rGFOnxCDCBnrRonCvFyDBeF8LXFrLXgZfhftUjlPaNu7oNDgqgiAWAyApjMyQLepxBaQV5MABhNoJVJ7yfB8wKIYdkATUo+nx6n7DjCF8AiRcgAUYVgfNw+U4Eb1nhg9G/c003ifOzmh+vTOi5wQwiNhWaJQiyHPgQjfr7XCxJEybLm1k4CaIzbFjQVT3sZXs4HvkVgeMJkfDyZXhthS5SFYReGsLY45it8Vp314/x1O6yl/6Ee6lAtoG6PvyMZbydhGG5TKcZzMQwghlqWD3ylvrcRQkMqS4cuvFQorESXIkHUvSFdUfgcF4IZVu6Bmc+03qv/7KzXinMdeyxt/GMkDpiDaRxE4FVLEYAExTxRwBWZqIAoeZEcw3HCQDU48mRC5M3IqwnJxxaA/DmNf7bdQqGOqE708whG9yUKpCzwbM17Tqlpv9Gd9GP/rTN/60lLLvc8dusKhT1gMv5HS6KEpFJ6wTKVvZoXOIUVzsL7JQJCvpZI8HwUVuoDooQxVEIYVqBB2EyRIYcXCK/YodrTWPSicrdfA9hvTQNY8cNwVCsQUiGyvSjZkhRLk/TUKXKPKGcQWCyCagEYnk2HLEn+O3WYJPqKisIIWNv50uPhzybPB86GaWyWVOGB7M0euO0Zte+V+ruzNjXe3hP/8yRU4d84S0IoASQvaMBHMx4cVsXMh36bJb1duO71GDzFRzR7gmEYnxuC3i8EAQzOF3LNUMCWh58tJilBc8718kv4Jm/+/pdBE85CeFUjhFU2QkQlJh5VBKDCbUlxs6lLRBFFXSrm3iNmE3xBTJBKnK/DJ6UXfrkIjJDNFV6u7TxgANsifLH47+mbFJiyVV3+7/j7837rHtdjEYbcmSoXomNpnCe9G2WxRjgtvlgiqQhtAp7u9SR8JYr0gALAYPxP7kLP58Tf5cxXGEBXvgcCp+B/vC0e8EsAO+Z9UhOQ9Sk4Jn2Bg+pz6PXcEFkh2pFi2TMo3CHCRV0EsY1eV+MCrwSNprrmidJJwkUAiukulUsgnADgY+3Q85E3jMMEIOsR9eS//1M4bq94VqlvU6xxmAxHwCKK5JgNQ2cIA+Tj9Yq8UIX6jvek1xPhWAdQ/AwDiK/pwtcUAKIXnOGB0BmN4Mhz43M80GvhuWF+B2CnO46dtOYeB/vIw2AfdQyCf/k5RBXXQTyG4zbo/eJnK2Laqok0WdiV9bV7mk7uJ3IyAQLA2WLmQUyJIXSYgfZfQ0mHsrnyZXUeJgdXTYPnDQs9HfouVH5L02sOCpGFBI2HEwhDRT7yCcPhJQhvqSbGgPI+d8+UesMzQUytXByKCygcY1jOd/PvsU5TYeITSr3fAdjmlx+AfRwCOOYDsI09Dja8WkeeAPvYTyF8xgVOPuLl3ClPcSFQ8dUaj5l43KRDOcfb1tTGVxJWGlPSl5C+Uf3vn8LnUvysZ38CZqmOmQhgyUUQyuJyKHqtZmNBbtnSvKG7VIIpwzV7TS7NqOxhwyTMjpkadFys+l8YDp94AhzjCL4PwTruQwgaexqCxnzIso46DWHTv0cIVQ6vFHa5ZalaNm3SOBE9ZewshTuJWdTONFt4OhI9n8JYz6UKlLysvf5T+mwoMbhpuRvhQE9VqhhJCIXgMCME+4DIyYrWxOOF6hAa8HkYOHoNauniGRNUSJEGMbMJwDNOvwIwYuIpBPAEwofgjUfwxn3EChz7MVjHfoQe8SMIvuvvEInJSRwmGRRGYw0AZa2QWtj1LmIp8oq0voJKG1V/UFXL0p9m53DqE409cx5wYzTA5IyK8wgizXZElojs2JtsKCLb1T1didrkPo0jQ4o9RtjmcWYx1REVfi0ClOaeLYO/9a8NNiMnngTH+BNgQwCt4xHCcR+jPkEgURiGrWM/Qe+IICKQrkmfQ3j+WQTPzV6PwKOEJULOnVLnMPXNUaE1BTPLG2qV3WO3KBN/Dp/TXc95Uvss99RcM1+5EFtMU3ceMecrM1+GjDwZqVhcadaDEg9WobjSv4XJn6MiNk398euUicYHy4C/+xeA4bedBDsDiCF37CkOwwSjTXo/Ao9kx/t2DMt2DNUOhDRsyt/QG5zH/7WNCJwHgvFDdJWJgm35y+pnNPPwc/y8ui1xJ+c8iP/5ChoFQKUi1NLMhgvhoquz0CNU4JGJDEllibAsi9rkTX0BxP/Aln7fhPkVgCHoAa04BrSOxevYE3y1IYhCCCOOCe0sgu+UECYqjjFHEcSTEJH/LURV1ENwRSPKAzfVevb7w+dW9gfPmUgEjEIneTonJRIkBM+OiYujwAdAA0LFADCsRIz/DADlgifLdX4GoBPhCxpzDIUQjjmOAFJCcsIrhMw+jsAjMPH2GMyQ8Xn20Qjg6CPgGn0Moqd/jVnueYgtuQB5zzTe5i+fXcVLHpVnNBg8BewInw3hs+ULCJ0zReE5GB8nCEMkgHqGzAAifDz/XC56Ef0PwLEIH4JkRQhtY4+ijiFsVJr5wHsdR2UZzJbHnpDej8o2xxBAvObiz+UcB8fEj2Ds/d++7Fcf3qDvXN3me+pdGI5dMxvQ6zUKABE8O814SPl6wRBZxA6Xsy3kAXUA2QN2+TzUzwA8igAeRgCPIHyHDQipJmgnGKlGiBA6dBkgonccc5LBDMo4AsNWfOSXU0mYjGy05jWCY0Y9er0Ghs82U2UAKQy7OAwLDxjM9UNVzqqILJg9YKnsvin3xxBMAI4hABE8gpCvx6QnFAA6WB9wtuwYT2UbOT7EZMUxHpOXEUdg/P2f7fVHALvOc9cETnWDfQZ6PxJ5PykKwcEIYAiJQrAOYJEPgBSGS2TvYbnmf0mIAFCEYIZw7DFDXvhQ43UAMQsej0kJZsL28Z+AC0OvI+04jFr72Yv+CCCG4JqAaej1ZihgzSfwVHCQCvTxnwTPmEGR64rlfHNksQeiikVWTIvf/c4DusYd4yTESkkIJyD6uE+M/Rg8vDpJ5P0QPseEj1F/QX0GIb/4BEIyT8DodV88+VP4e29eXx9V+qK7atrT7po7n3LX5G/93zWEXrNQrQmcBmDPR80EHPNp3HBACqY5X1+vV6Q2KUJH4P1IhlAxOmosw85E+FcZZvwJBk+UYU7KrPcE1wbt46hIfZLLLZQJs/eb8BEDaPcBMDjzAxi1+otHfgp/b9/V7n2hFBplRwp5q7ytl98K1XuxWmOfDvh6gNBpmGhoRs0vRHbT8NQbT+EJ+MLlzgoRRcIL0noRhrMEQ/AIPwMwlACkqTguQgsAGcLxQgwgez4BoFMC6JjwKd7+iwHgyNWfb77a/9bbt9SviqMpxWqxWi5W7nRgn6xA3nPuy4Lw5hq1xjFdw3EegocA0pwud7w083o6fOI2g0dAkjhMaxBKAI6pj/Q7ACnsEnzW8UI2BNKmAzjhlNSHLALQKQF06QBmfAA5tZ8/eNV7v9oGbqCIrRa9jjG0zrdUeMIw9IqZ95+f2trXvGWZWuNEAEMRQIIorBhvswg+zWg60AGMKPECyPAVebg1n8M1A/gP/wIwTAeQQvA44Q15ak4CaJ+AEFLDwsQPJYSnRRge/zGOCWUSkn4Cslf9ddPV/HdmbrwwNbrMzS1kxs4IvIsBNQPguG2qCkXPNfytta/bDwEMztdwTEeNrBe1Yvl0TzfzgByGBYRNAMz2NwAnnBAJyBgxFiTvR2NA4QVPyFAsvCBd7RiG7XK+2D5OwGhNPYkh+IurevX/wJXfTooocnMHT/wsuTvCLIUbb2mhefB0BHBr/Xetfd0BK5SacPR8USXeVXJGW77sfDHGgMXeMWBE0Q8A6HcecMJJkYToAMosmAEce0ICKcaBPCVHNUBZB+Q54vEE4CkYs/7rqxrAW5Z8fVtooZtnG2Lllhws9IC0I4JzmgoFWy583drXHVyr1kRRL1+pWJQeWeptxw/X2/iLvL2E+lqTHwTQ/5KQkxBEc8ByLtgmIRRhWYIoIbTLbJgTFW5M+JABDEr7EHLXfrXhav47Uzf8Y7qrwM1JR6TchkNssaFwG5ntbhUKn6k729rXHbparYlBcOLKNYj23RnBxwOG0TivyDcM65lwUwA5CbmjIcqvAAxGmAJHH4eg0cdlMfq4LMvoAOqSYVmHkAFED4gJSVDGachd982aq/nvTLvvzEyaqXAWe9DTkGTTKMLhRBgC7lSh+Nk6tbWvO2wNAlgKEF8BvFcM7ZpgLE6X7fZhPgr3WVkXrntBWSukdn7LpHORfgbgKR8AjwoIx+J9Keu443zfC6LwhDqAVJKxZX4IOau/Wn41/53DN3wz05pXD85CEjUOuMWUWb4HgvBq+aWCHrC+1aWYIasUBjAOAYwuFzsm+C5G1+uAupqMBX3rgIVihwW/64j+IQANjfPethmtWr4AfgT2zFOQs/bfA+Cgdd+Pm/j42TU3bjyT88+eN2LDtzOseQ3gKqwDZ0E9t0vR1Jl1hhsC893oeTwUglsN4OBaxRuCLwIwpEhpImMVHQFYdBGARX4KoAthCsw99oMA2sYd584Yvs/hWQDIndEIoJMBPAkZtV8uvrLv/HRE4VYF2teokLREgU7L3JD5SD0MeOhC9xbHauv+PtWGAAYXCQCpbSpohooANkIgyvILN4Xg1gO40sMAxsodsyLQG9JYLkQCyC1Yhb4ANg2/vgBG+uVcMAIVOPqfAMhLNak16zj3BwoPeIo7pR1jPwLnRBQCmL7iiwVX6j1PeLDx3p41Hkiep0KXJSp0o0MHlyrQeZEHetU2HG25XPL3SU4DwAawIoCB7AEbIYg84O0eKNla7261B17hqYkuxvFfOfAOWTSO8wIop+SKFUP6Qna9JsgNCXJsSHsPWnp/HeqHAFJPIII3WgKoS/YF2vTsmNYOj8HwOwYBHHOa14lQIdqVeYIAXHhlstnve3e4xwOdaBOjhSofONhlqSq0WIUOixXIfeRssx21+i/79jZXXiNC0YAAisZRDsE0BizAMeBkBYqfb2h1HbD/MlEHjCgBnssN4fUhqlyQpDUH0AjDwgsSfFFFojBNmbnlhq/8DcAPED4EMFcCeBGENt0LykXrOoBWAnCMANCZ+QGkrfj8ioTg239dl952DsJHHm+xOCNEP+2SVuK1X6TB1Kfqnm+pEE0AhhY14jjQze1S9gLROGrFBMAyVYOSFxpaXQe8pUapCZlJa58FbASfU14ZQPaEHl6SGVLksyxTNiNEFYt9CyPoODBqyb/hvH8BGCwBtBKAuRLA0T4AjpFjP64TknQP+CECiGNAas9KPwaZK75YeSXe78RH6wbpANJB0ylLND4BvRPe7sj7E2pw128uPNF8rHbmdid7wEY+5ciFMPBKNlrFhl++NU+D4hcaPm3t+7l5qVLjzBeNCE6WCo5CAWGw9IQMYNFFAOoNqVImgL4ekMOxkA6g8H4I4OgTEsBTcpkmesMRRyF75ef3XYn3O35zff+k2Qp0WIiaT+eEaNB+IW14pPGYkLYHufOx879uVgdc/910x3T0fsVurgOG6hsJkTCBCEYvVvh8y+PHf2Y3IoC2GYDgAdhRDoSwKYDe0KsrvETMiNAuXNwR7Qtgt/Mh/hWCEa6g3CNiDMhJiIAwiBMTHUThAW2jSSfENfcDsOeewOecBMvQI5C79ovHrpQHpAYC3m9wDm0HJ3baEgfO4BdZpcKUx843C8GZ931XaJuOnq9EHjYjd8Pn3fGrMHkoAih4ruH91r6f3kuUmsA8AZ+N4CsieQEM9d0lq0RfjCS6cCJlO36kXKREe09buvqZB9QBbOoBj8px4VEDQBtLQph73FAQQmgZcgRGr/3yiSsC4MN1g2j/5ljayHyWOGLLOF6LTrTETPKux8692BKA9jwMg6ViFweCj84G4b7AasBwCFD0fOOhywEwYDoCWOAF0DsGlADqu6bKbXz1XRF0DxgpwYz0QwADgynEXgxgrkhKRGIiQ7EBIYGH9/E5tlHHIHDUB2AZdATGrv1yy5XxgPWDKXzS7v1iXxrvsVq0t4oTv9i7n7jwysU/l/PguUInZrw070sH0BB8tMsXnRdCIEdeJoA3kAechqG3gCD0jgNdsimVvZ7c3leHrwmAvDeM2M6NFyVFfOlXITiIFpYbAOb6JiC0WMk7JmTodBAJPgbwKASMPA6WgYdh3PovX7hCIXhgMM00VIuTiyLoPLcq74lGDgLw8QvNPODw9d/dFV7oEZ6vWpyQlDBLABgvASx+ofF4a99PH8yCA6ZpDJ+D14PopRe5/LJEbvVbJhYd8RYcPgBGyvNEuCxDhehr/KsOGOjiUHvY8IBBzXTExzMeYwn4jrACRyGAgxDADV9e9qq4AQ9dyC1/yXM+7REF+mxUofwPnvOWSefiWnruuM11/Z20BwsCF0KnV9JhgvJEy/AKhT3g5F+db+aNb135j3HRmHzEVstt4wg+uvJOX/gaCE7R8w2nWvveb1qGHnC6gM8pW/L1bdmMkHvxcQ8GgASf3pIvkiJ/mwmxegEUsImxH4IlFSSlh2bdUwoAj+JzMAQPOQzj7//qsgAsfcFT2n6eG9rMFYcRJi1WIQaz3K4r3DDk0YbcZlnwI3UDaBsMJzWREoCYTIRVytMsCUB87PbHzjbLgm+sOZMTW+rhQwmNvQtniTEgnQ9HtbziFxo+uxwAqYRDns9VJNrx9RVuvJs+Tc8Z8GliAbq+274PgLxvDAHoX+uCI+wuBusQWEcdYRC98B1G74b3Rx02IGQhdFbp/UhBmJRYhuEY8N6/PXM572DgSs9pOpK10wKFdwileh4dxRoxS4Xe9zVfrUZZMO86QACWiqQjlI9SVVgufGzSw983WyDVu+bbrDgEMHaWF0DyfHRyEY0LHTNUBLD+7619/32XKzWOfLkOxHebXgkcQ+gz9jNkbIQuegI5YSn1u92x0p0uCrGjCMDDDGIQSQePdYjF/zZK/JsOoJ2uYz6AoNQjMGrtZSzLvPnb8I6LFGi3kE6WFGf+tl+gQvI8hGM+QChCOOmFuuG+P3Lbr+qG8L4r5Sr39FFWS0d50VGqJLp/24Pf33vxr+qx4KuMOAzBtBM+H8taKepudBwXQRs4FQF8rvVzwf1XKjWh1JJfhpk0SxOnq5c1PU8kQi/B+MAXWewdA4aQ5yyjOuDf/CkJGelykVcbeVDqfQSMdNArfNyKj5OCct6X90mHGEBqUrClHYKs1X9tfSF6xJn2bfn8EIXPCuEjIOQZv3RAjgu904Snmu4cP+7h84Noywsa/3GoK5fJiDzNMhQfn7jpu2bd2TfUfJMbhUkIZZqkcNk4QDMVNgydlrs0yL+MfsChq5SaqEJqxwKIRgD1hlSj7FLi3YY3Qhahw4s9cmESZcAevnKTAgE40K/KMAjgaF8ADwgIfWTFx3QF5eA1530JJAF4WACYeggya//a6pb8wPLGHuI0TIX3R46Zo/K5IdHo+SJRjnJPMwBHPXDuFtrigs/ulQXlSD5eVZRXaFajJQD7r/72tvCZbu9upsWiTuekHeplM8L0LZcB4GqlJqYIIL6cOmI0HwC9xzWElyg+q+Ga3qatOXQAaSjgZwDiGJDKLQRfzkEGjDXSqyYAjnzPB8KD4mgHKtkQgKv/0moPmLjYfSMdDxZOorIKgYfjsshqAaC9nE5OOt/keNOMDWdvpOIt70ktC8rR8rBpCq0E5MSHmgOYev/3U0JmNPKxCy7ewZT2b6GDA91gRVnudMO0py60GsDha9Sa2GKANjqApb7QySWZfF96PZ9/48VJEkTeL5AAzPCvQrTV8IAEVQ4BdpFG+ihHB/AA2PD5doTWRiF8xEHIWvOXVu+M0Pd+z/DgKhyAV3sgpMoDoXg7rEpMp1Gh2VHhgTu21mX4/sywDed7xWOo5SMgqjWjrBInb0dWAI0B1zcb7T7w3Qzn1AZwzawDJ22jli/asWz5jXhtQAAb0QO2HsCMDWpNDI7f2lTIptRSrelRXhRuS3ylXOQVPQaAvEl5/3Mh/uUBjTEgeTUBWWA2KufdpmoC4HtgzUYIUVYcJ1qGv4djwI+3tva3D37Mk0XlFFelG4IrBYAR1fKkTgzNwTgGvHNrQ7rvz/RbfbY7nfObOFccPB0/+2IANfjlI+ebeeORm88V2+6uQwDPgyP/gmjFz6N+QARwpgBwxtOtBzD9XqUmEkN5vFwVF+l7JIMEMKzY7QWQd9X3CPksUqdeQhpCWHqeDfZTAA/KMHtAACjFQJLYC8qwTAAyhO8xuJYh+2H8g5+0uoTR5/76EVS3I/hC6CCbanFGMB8LhplwGAJ5+3P1qU2Tie86J1UpEkDgg3DidQCrxB57CGCzEJz90LmZtikCQKcEMChPrAmhrmgKwXlPt74lv9t8BBChi5HnCNO4VD+6oUUAdfg4JHtkgiJWxDGAEd+5/ApAZ+7FScgBCEAvFyh18bjQKgH0hul3wZK2D2ILDuOXt79Vi6qvWV03iLpTQhFACr007oubK0/aXIChrBoBfL5+hO/P9Fz6Xae2+DgfB8bFZBDFZVleIQAnPXp+3cW/K3Pj2Rn2u+shGOFzzqwHe76b9/SzE4B5HrDc4YH8ZxtaDeC1S5QdsRUEoGocXh1e6tv94gUvolQoXMJHoiw4Ugewwu8AHORyUK2P4TtkgBiIY7vAkUIiOTnoU355n8eAOny27D0QmLUbw/Bu6FJ47PRNcz9rc6m/Pbr4wg2UlUZXuSF6tjgWNmmeCu3miwOwyRve9mz94IsBTJoljn5NYM8HrNgq4ESEyit3PFbXbAw4Yv33k4OnNkJIASYiBW7ePNLFW7ThWBA9oeV2hbbm0Frz6RW+qNzZibw1zS+Xi4XutK6Dj3r1Oe6VFHmxZCtWFAIYLeuD7AHbfe9PAF7nco5ED5hzCME6zBAGogLwviVHXAOzCchDXhCpFijhs2bvBXvW22DLfBMC0reDZehuiJp08E+X7oC/jIvGrDRuthviEb6294hCdMdFtLYDs1y8P/6ZugFN3vHS71K4g2WO1+vpRWXa6DsEPcnkx+ua7dRFc8EReW65JYZqnIRJO5jS6jjLL1Rqyb/knRFm/F7ZklTm4ZOg6NRPusZWysy8nDYdF/s+i2MYZNeLPBckmiUOx46h26XCA0b63xjQYnWOPCy9m5j1CMRrQM5hhk8AqOsgKygbAcx+F7UPgrLeAZsEMCj9dbCkb4PAEdtg2NxDu+i1L+UN5N5f96eEsnreMo2m4DotVLnVvuNijc8oHrelrr/v8wesu9Cdvmhuw6oQZRcuLpeJ4i/tcjD5iQvNmmNvXHkmJ3qGhzcRisKsNaJIHMtKO9jb7lSgzyoP9LvvbO6/fMMTwVnxe+V8bIWbwYmvoGNnVUN86nq58IRREjJdfB8fj5EirxkrAaQpPMr+LUP9Kgu2BOoA+k676fAZHpD1PoZahC8LvV/mPgjMfAevuyEoYyfCtw1sCKA9489gzXgDLLdsg+Q79kOPO/fOv5Q3kfnrszOGrm2EpAqF13WkLBZekM6aG/dkUwCH3VvXk8dZMtyGIHw0+0HzqHQ8lh09252Pn2/WHNtt4d9HxM3EcEcJQ4kQtcLHFjVA3m/dl9jLeNw+6mH1ZNjd6MkwQ6dxX1yFOPfYAJC8cbkOnIBLeDp5pWZa/DsJvjiS9IYEYDgBeJN/AWilECzmgo8IABFI4QW9AAYgeAFZmJQgfIGZ+yEw4x0Ujv0ydqHeRm1DCN9E+F4HW8ZrKLyd+hYEoTeMH7PjwLB5B8otlmf/5SR73rPucbfWel6m1W2UjJBHGP2r800AHPVQQx/ut8MvLxghctJ0Gs9u0LGqmFjg2G7KUxeateTbJnzaO77Iw0C0KfdA32VuSCx3Pz7lN40Z/7TMsqkufuyjSk3Pxco7XReIsRp5Lwqx7M1k6OUwTMXwCrFDAnu9UpGcUIYcKyEk8Mhrsug2vg69Xig1LlQTgP7VkGoJHXkUbDi2s/I4UCQbAXg/gMCTXi8wk8B7V8CXuZfhC0L4hPd7mz0gKTD9LfaA9szXwJH5KjiyXgV79g6wYoISOeF9DM1H/xMHfoGX4mkqXla/TpmnwOiHzw70/ZfxjzTcascxmwu/TBd6MHspQUhNCG70go28zPLuJy+81JykU73iMeMdsbIOk5zv+13Sh3P3364bUFsPtmkeTiyiZGIRzuM7AlBhAJuoTNQDSTFSsSQENxbfa1yZxjXDNiwEkEGlzh4N2s6nbhj/GgNaUm4/CnbMbG00u2GUYdDjZR8QXi9TeD0Ku0EZe2XoFQBaEUAresCgjO0CwrS3JIzb8fHtODbcjhDiGBGTFWvGe2Adshe6TD2w45JzlMrG6yyWHY4mQ7DN7ltteRo3I7hwLOcoISnoDd0IYSNvONQigGgFz9Z93K/mbPd/+Ysnn2mPzz3dvrqBx4iU3HD3SqnMbsu8yQR5LzGu04T0MV+p2DPQC6HKEMbp8FXoACo8NnQWqDDqUT88sDo6690d9lEHwJG9H5wj9yGI6OWy3kX4pMfLwPEegkfwBTF8+thPekDWDoROikPyTg7PQZm7EL7d+JqYrOTsBVvu++BI3wfdSo5CyuQDUy/n/Y5aXd+HAcQvUQfQSUekltKpnQ2829W0LRf+63I/jylP1o3vuagRXPg6BAZ5NT5Gy5DIcKPKhQeMlgDq4z4CT1cMhetSCZ8EkMIugZcgFc9dPBqXhEp+99M60PtHsZ757y+xpu8BR85ucGVTRrubgaNxXhCHWqFA8nqZ4hqYsVsAJhWYKWDTFag/D8N1UNY+Y9ZE1A8xkckUwHe9+z3odveB5RbLJPulvt/r879LoeZPWn/rLAJwlYBYe1vSCGFlDWDL82BSUfdqaz6DxIcvJE1+sqGm88KG33ec64Y2OPZMpC189WWbhmg3VSkJYZTMblny+NZoWuMrEx0BoIAwrkwAmIBQJ5Iq6Xco3EOYvllrsMyFCIsfWmDwxL0QgBAGZe+U3ssLmFWHjJQurxfBF8DQ7pahWU9Q3pEQC48amH2ARfAF4XjShiHdPnIP2NL2QJuJ++Haybvvu3Qv6J6atdkNTm4mIBA1sFJP3zQVBm9Qvrd0b3k9SYth+en6so73NLKn40XuczRoh/C1RSXQFr60ZoR21sfbBGNMpfB8TQAk8PRF5iWqISowG96QvGmpyHwJOp7PJuFr37iKQq+fJR9N5kNW/6UqYPgusFB4RQhtWTtQOK7LEiFVJBqknSw9xArthgAGdo8PeHhNJ+Ht9L0ijBOEKIKPwrkVfxePITPfBkcqatCbcF3hXrD0f6XXpb7vsb9qKO5bq/JaXGpImPK8Cr2ehuRL/flJj529rwd6vA60xcd8DTrMFQC2na0Bz7bwkk1atCT2lY6pEgAK8IQoGdFnNrzygbBUKEZmwXHUycMAKgx54iwFfrFVLbX4u2U+8NnGgGHolTJ3QEjWa+BC2SipSMPsNg1hTEUY0wSEgTqE6bukt9zTBMCAdAGgfmUxhJTMyDIOP76LwXZmvAUOTFoCB2+HpNv3QMSEPWMu9X3fvKk+Je8l5YmRz8Iln1M86oFzpcM31HMGStt6dKAZGISv3VyA5DkASQhg4mwx1Rcv147EVmkSQD3kKobni/RZZOQLIp0BxyAWixMxo/GxOLy2QQgJPCoH9V+v7LOYJseDpR/16jbl4KshGB4d6PkcmdvAmv4mwvcWz3AEpiIkaTsQnLcZwgAESGg3wyaEt9NQqSQENG2nUPpuDs9BdCVPmkbaAVYE3Jb2BtjTXsMEhaB/jWuIXacfANfE/U8Oqnj/lh/jb8t5uvH6MY831nRf7P6QTktKmK1C8j0aJM8VaotKmiPAM84Rkcs29WYHUecT02dRMnvVl1h6136IRtNIqXBj6k8RR3MVi/NJhq5VlD5L3SvGPqUkmuRdZMED/tJ35OJT4BxKAJIQQIIwdRvCiBCiNwzEsBmAEAWk7TJk0ZW6Eywj8N9Y+LwR9HzpMRnIHQxfEHnWtG0MeFDam2BDAJ0Zf0YQ/wdsGW8gqG+BK3cXDF9y7BWLZfVljZHarf4+ueTFegylOGYs9XC7P3myuNli7Qk1tiaQGDyNzxDRV80J8FSGT5/toKm2mPKm02u+HpCPaCiSZ7/RSrcCcWAh7cJly1PhxhoVhj+q5JqUXYLdUnZyTtRo9FojZIllBM1uIIAEFIrh0iFMJe1k+AIkgBYJXwD+TABBiyE8kMP4DuFJ00T9MJDDvICQPK6Y1qNi9utgzcKfGboDkqa9Cz3z9s9v3V/wqWvIfe5vbMVimSe1e0Xydh4IEo3t6KAaAtFXPss2fT2foQoxm+Fb94sq9S48ogbT0EJxUCEdiBhcoEDQdAUCpyhw0zIV7vw1DDTJaoUNn338F9FjcMw24C0MlxQyt/MUG3tCBvFt6em83o6V6gMfPj+Aw7cAkEM4X3dIbZfaxh7RiiDaM1CZb3FCZB1JSctefGwP3LLgw+cvaZy35ULhwHsbecYkeo5YN0Lw0XqT6GoFYhA+AjDOkColvCDtGxNfrR9mo3lVoXtBzZDhBUvF1rsEYHCBgM+K4CVWuKH0ec9xk6bLtt8Fp1UfqrQN2PbbqOzt7AkpLFspJDfxiAK4QBIDuk3Ch0rbbowdjSsXsfF2pve2FYG0pr/NsmGWbcMkx0ZdNzn7wT7qfQjOPQApk9/bG5T63z1beqfdF9WP6r8ax2dVYsUcZ7C0c1a1WG0XRYuZpPjQwmoJYLUqJbyeAFBvMtC4549VoTcdyM4XOfdLW6tFyoXo5Plc+Qpcu9ADQ9Z67rNUQKTJ0I9kXe967+Z2kzGj7f8GBNAYMRU9VeobYOPwjOPE4RhOh1PS8ibC56ttXu+Xrs+W7JSF690s32K2qDPuwRC8H6zZCB8C6Bq5D0Jy90HwsJ3Qt3L3npbeX+f5nh0RmM3GUqd0FYhQOlvfwg3Bm+UFMIbOiaNTM40an2qEWl9vFyc7V6iITI/FVypcTqFjvmKNmRCEEIENQ6+XtckDo7coU0xa/g9t6JyjW6PGIRxDt2NoROEYzo4wWkcgmAhgwPA3hRg+fIzgxBAegPAF+NYRGTjKkIWseF9oNysIAbRlvwsOBDAYQ3Fo7h4IxvHkrVV7WtxKrccCz97o2d69X4wxHUMowqwBoKzt8SyH3kzg26tXLuZuSdRA4O39U4Qn1MMxbW5UQWcGq5C2SXndpOOK2YG43vnHPbbBOxHA3ZjBbkMIX0MP+IYBYGATALd7a4gZooQTqINH3i5jtwRvj1dZ+xBA9IA0V52D3m/UO+DCEH9j/vb9Lb2jaxd53o2d5RNCjc2IwIAxtlqv7UkA5ZlxDB9nt6LXL7ZMNcATIu8nPGCbCjGnS54yvECDzvM1KP2dttdk4gpbl198Fp0693RNUu7BP8ePfxcBRE+IWawj7VWwEYwjJIwEYOp2zpAZvPTdskAtpu8MyYYHSjpotiQoay9DaM/ehwDuRQDRA+JY85bSXS1upda7RjnIa4ZbKqv4wEdei/eJkd7PaCgolUXjUjl1ViY6VxIqhWj6LKFahGhaB3zNIu1w8QtajeU2CDNpuAqsx4yDp21D/gyO7DfAnvU6F5aDEEIxLtwu6oFcoEYA0+R0HTc/iI4bo/OGpuu4A0dkwJSIOLIRvpG72AP2r9z9RUu//4YVyqE2tGBprnff6NgmiYdmbFDEuylUygZS2UTapKmAevhk/57eREDzw3SswnXLNMh7St1sfuNXmyXsj8hcfOSMg7qih/4PODJeRY/4qig2cwF7l1RTALnNv0UA3+FQbEM5s3ZBcM7b4By+HQZWvdPiOuQba5XDCfNpaScCONcHQBluYyV4YlYDWNHlYEAollaKBeaRpaKZILbUJxFB71j5O7XRYgG7+WVfxRZ/x6GcftXvISyvgiPzDS7biNkPH/hIPsB55ROSZfe1DceNzszt4MreBrZh22Bw9d4WV7D1qVWOJMzzBVCTAGpGpktt87p4TW+5ZpRTouUCJ30bNfaCFaK2F1mowJhHlS3mt/uTCsnvTU4cv+NQWM42zJBfl8XsnShMNtL3+PQcviNbuXzB8zYs2NK3YZLzBkL4OgQOfhOGzt7X4l5+fVYpJ+IlfCIEyzFfpbdmZ7TM62s3yrwLicj78Q5atGMDAhiHt/suUz4euk6pueNpdZD5jf5Uzbm3W+6KU2dcQxAmhM+OSYgVPaAXQh263bJEo3fcvM2zI9Sw4EyneeI/g+XW12HInH0ttq/fvFr9OG4u8PENYt8YGYKNZENsIKQrUm4UGVWs71qvQSiK1p3QAvnC/9DmmF/ez8gGFhzf4hy4E+xDd2NY3Ydju3e8pRcqPrPH0xc7yYYFHD/aUl8HZxqOKVGWfq/BwFn7WwZwjfrXmNkAcSw98/UuGmevp7dRye4V4/BoXtqpcTkm/3n8mQ3u3uY39jO0/vmn5ne96xBYB+xEAGl3BbqKcZ41fadPpwzBt80LYOp/gyNVADhg9g8C+HVkNSYV1XI2RN+4SE6dxfoCKI9MpV0SaFF7MF6vX6pCxmPKBPNb8gPLuuf0HR0nHdjmyEYvmPY2grgds2bqDXyTp/gIPtGHiCEY7ztlz6BlwJswaO57LQJ40yr17yGY2dLCdTq8Jqa6aWeLMcUm26moZYpKLreuVM9dt1RdMfVptbP5zfiZdZ71UW7/ucfANng7JhtvgT3jLR7zWdNEDyK1clHy4sjARCQLPeLgbTBs/vstAth7ufKls0wTC70rxGlKNA6kBlPa0DIRlVRNazEw5BaocNNyvC6j5Z+m+b3duviT4rDcvRA4ZBu3YjnSXmfPR00M1B1Dbfuu7B1gR1BTFxxsEcBei9wf0WE1vIl5udjCl1qqaKUbzWRQu30Crc3IVyDjfhVGP6+Y4zzTvNav/Ghqu9vfA+eAt8CVto3XqFByYke5st6GECpED94FGYsPtQhgj4XuD+jYBTrEhrbvCJd7R9MYsA2F4GINbkWvN/0p9UHz0zbtBy2n5vSUqGH7NyaO2Y+JxzsI3zsQkr0HQnPw9oBdkL3s+Jct/VzKbPduV6k4qSi0XJ6gVCq27h1Yq8Hw+9T55qdr2iVbctbha26YeRjs/TBDvnUvZs7vQNQETEBGHu/WYghe5qmxTiH4ND4J3Z6vQdomFW5/XjXreaZdvl1/58E5mXOOw/A5H2gRk0//8IzEwPOhv3xUgQRMNDotUOGOp5T/Mj890668LWjoZqlu6GJ+EKaZZppppplmmmmmmWaaaaaZZppppplmmmmmmWaaaaaZZppppplmmmmmmWaaaaaZZppppplmmmmmmWaaaaaZZppppplmmmmmmWaaaaaZ9i/s/wPIGnYUxb6/qwAAAABJRU5ErkJggg==';

// ponytail: the export args ({ title, analysis, headlineSegments, png, … }) are
// big untyped envelopes — typed `any` throughout this file; the vendor globals
// are already `any` in globals.d.ts.
function escapeHtml(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the report as a standalone HTML page that mirrors the PDF one-pager —
// header (title + brand lockup: logo, "Ordinate" wordmark, date) + accent rule +
// qualitative analysis + headline with bold key figures + the chosen chart + footer —
// using the same hardcoded LIGHT-theme tokens as buildReportDoc (the report is always
// a white page). Self-contained: inline CSS, inline logo SVG, chart as a data: URL,
// no scripts and no external assets, so MAIN can render+capture it in a hidden window.
// System sans is used (not the bundled Hanken Grotesk) to avoid embedding a font.
function buildReportHtml({ title, analysis, headlineSegments, png }: any): string {
  const C = { ink: '#18181b', strong: '#0f1117', muted: '#6b7280', accent: '#2563eb', page: '#ffffff' };
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const hasHeadline = Array.isArray(headlineSegments) && headlineSegments.length;
  const headlineHtml = hasHeadline
    ? headlineSegments.map((s: any) => (s && s.bold)
        ? `<strong>${escapeHtml(s.text)}</strong>`
        : escapeHtml(s ? s.text : '')).join('')
    : '';
  const chartHtml = png
    ? `<div class="chartwrap"><img class="report-chart" src="${png}" alt="chart"></div>`
    : `<div class="unavail">(chart unavailable for this view)</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; background: ${C.page}; }
    body { font-family: -apple-system, system-ui, 'Hanken Grotesk', 'Segoe UI', sans-serif;
           color: ${C.ink}; -webkit-font-smoothing: antialiased; }
    .page { padding: 40px 44px 44px; }
    .head { display: flex; align-items: flex-start; gap: 14px; }
    .title { flex: 1 1 auto; font-size: 23px; font-weight: 700; color: ${C.strong}; line-height: 1.22; }
    .brand { display: flex; align-items: flex-start; gap: 6px; flex: 0 0 auto; }
    .brand svg { width: 17px; height: 17px; margin-top: 2px; }
    .brand .wm { font-size: 13px; font-weight: 700; color: ${C.accent}; line-height: 1.2; }
    .brand .date { font-size: 10px; color: ${C.muted}; margin-top: 3px; white-space: nowrap; }
    .rule { height: 2px; background: ${C.accent}; margin: 12px 0 18px; }
    .analysis { font-size: 13.5px; line-height: 1.5; color: ${C.ink}; }
    .headline { font-size: 14.5px; line-height: 1.5; color: ${C.ink}; margin-top: 12px; }
    .headline strong { font-weight: 700; color: ${C.strong}; }
    .chartwrap { margin-top: 20px; text-align: center; }
    .report-chart { max-width: 100%; max-height: 420px; height: auto; }
    .unavail { margin-top: 10px; font-size: 12px; font-style: italic; color: ${C.muted}; }
    .footer { margin-top: 22px; font-size: 9px; color: ${C.muted}; }
  </style></head><body><div class="page">
    <div class="head">
      <div class="title">${escapeHtml(title || 'Analysis')}</div>
      <div class="brand"><img src="${REPORT_LOGO_PNG}" width="13" height="13"><div><div class="wm">Ordinate</div><div class="date">${escapeHtml(dateStr)}</div></div></div>
    </div>
    <div class="rule"></div>
    ${analysis ? `<div class="analysis">${escapeHtml(analysis)}</div>` : ''}
    ${hasHeadline ? `<div class="headline">${headlineHtml}</div>` : ''}
    ${chartHtml}
    <div class="footer">Generated by Ordinate · ${escapeHtml(dateStr)}</div>
  </div></body></html>`;
}

// Export the FULL report as a single PNG — same content + layout as the PDF one-pager,
// rendered as HTML and snapshotted in MAIN by a hidden, content-sized window (2x on
// retina). `png` is the same 2x chart/map image the other formats embed; the dialog's
// map/fallback handling already ran, so a null chart just renders the "unavailable" note.
async function exportPng({ title, analysis, headlineSegments, png }: any) {
  if (!window.hub || typeof window.hub.captureReport !== 'function') { showToast('Save failed'); return; }
  showToast('Rendering report…');
  let reportPng;
  try {
    const html = buildReportHtml({ title, analysis, headlineSegments, png });
    reportPng = await window.hub.captureReport(html, 640);
  } catch (e) {
    console.error('[export] report PNG render failed', e);
  }
  if (!reportPng) { showToast('Couldn’t render the report image'); return; }
  try {
    const res = await window.hub.saveImage(reportPng, reportFilename(title, 'png'));
    if (res && res.ok) showToast(`Saved: ${String(res.dest).split(/[\\/]/).pop()}`);
    else if (!res || !res.canceled) showToast('Save failed');
  } catch (e) {
    console.error('[export] PNG save failed', e);
    showToast('Save failed');
  }
}

// recommended/selectedExtra/current: the same three-tier picker state as the main view
// (chartable types only — maps/tables can't be rasterized into a report). vizData/entry/
// turnIdx let the dialog render a LIVE chart with the real "⋯" cluster and share
// entry.chartOverrides, so Values/Periods/Customize tweaks here sync back to the on-screen
// chart. The chart TYPE choice is report-only (it doesn't change the on-screen selection).
function openExportDialog({ recommended, selectedExtra, current, vizData, entry, turnIdx, hasGeo, analysis, title, headlineSegments }: any): void {
  closeExportDialog();
  recommended = recommended || [];
  if (!recommended.length) { showToast('No chart to export'); return; }
  const isMapType = (t: string) => t === 'map_bubble' || t === 'map_choropleth';
  const overridesFor = (t: string) => (entry && entry.chartOverrides && entry.chartOverrides[`${turnIdx}:${t}`]) || {};

  const overlay = document.createElement('div');
  overlay.id = 'export-overlay';
  overlay.className = 'export-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'export-modal';
  overlay.appendChild(dialog);

  // Header
  const head = document.createElement('div');
  head.className = 'export-head';
  const titles = document.createElement('div');
  const eyebrow = document.createElement('div');
  eyebrow.className = 'export-eyebrow';
  eyebrow.textContent = 'REPORT';
  const titleEl = document.createElement('div');
  titleEl.className = 'export-title';
  titleEl.textContent = 'Export report';
  titles.appendChild(eyebrow); titles.appendChild(titleEl);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'export-x';
  iconOnly(closeBtn, 'x', 'Close');
  closeBtn.addEventListener('click', closeExportDialog);
  head.appendChild(titles); head.appendChild(closeBtn);
  dialog.appendChild(head);

  // Body
  const body = document.createElement('div');
  body.className = 'export-body';
  dialog.appendChild(body);

  // Chart label + the shared picker (chip row + "+ More" three-tier panel)
  const typeLabel = document.createElement('div');
  typeLabel.className = 'export-label';
  typeLabel.textContent = 'Chart';
  body.appendChild(typeLabel);

  // Live preview = a real chart with its own "⋯" cluster (Values / Periods / Customize),
  // identical to the main view. The format buttons disable while it can't render.
  const previewArea = document.createElement('div');
  previewArea.className = 'cv-viz-area export-viz-area';

  let fmtRow: HTMLDivElement | null = null;
  const setFmtEnabled = (on: boolean) => {
    if (!fmtRow) return;
    fmtRow.querySelectorAll<HTMLButtonElement>('.export-fmt-btn').forEach(b => { b.disabled = !on; b.classList.toggle('is-disabled', !on); });
  };

  function renderSelected(type: string, info: any) {
    if (!info.canRender) {
      previewArea.innerHTML = '';
      const m = document.createElement('div');
      m.className = 'cv-chart-fallback';
      m.textContent = (VIZ_LABELS[type] || type) + ' needs ' + info.needs + " — it doesn't fit this data.";
      previewArea.appendChild(m);
      setFmtEnabled(false);
      return;
    }
    renderVizInArea(previewArea, vizData, type, entry, turnIdx);   // live chart + real ⋯ menu
    if (!info.suited && type !== 'table' && !isMapType(type)) {
      const note = document.createElement('div');
      note.className = 'cv-fit-note';
      note.textContent = 'This chart may not be the best fit for this data.';
      previewArea.appendChild(note);
    }
    setFmtEnabled(true);
  }

  // ponytail: picker is the buildVizPicker widget object ({ switcher, getSelected,
  // select }) — globals.d.ts types the factory's return loosely as HTMLElement.
  const picker: any = buildVizPicker({
    recommended,
    // Charts + maps (maps capture via capturePage); the raw table can't be a report image.
    pool: ALL_CHART_TYPE_IDS.concat(['map_bubble', 'map_choropleth']),
    data: vizData, hasGeo: !!hasGeo,
    initial: (recommended.indexOf(current) !== -1 || (selectedExtra || []).indexOf(current) !== -1) ? current : recommended[0],
    initialSelected: selectedExtra || [],
    onSelect: renderSelected,
  });
  body.appendChild(picker.switcher);
  body.appendChild(previewArea);

  // Format buttons
  const fmtLabel = document.createElement('div');
  fmtLabel.className = 'export-label';
  fmtLabel.textContent = 'Format';
  body.appendChild(fmtLabel);
  fmtRow = document.createElement('div');
  fmtRow.className = 'export-fmt-row';
  [['pdf', 'PDF'], ['word', 'Word'], ['ppt', 'PowerPoint'], ['png', 'PNG']].forEach(([fmt, lbl]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'export-fmt-btn';
    b.textContent = lbl;
    b.addEventListener('click', async () => {
      const type = picker.getSelected();
      const isMap = isMapType(type);
      showToast(isMap ? 'Capturing map…' : 'Preparing report…');
      // Maps snapshot the live render (capturePage); charts rasterize offscreen at 2x.
      const png = isMap
        ? await captureMapPNG(vizData, type)
        : await captureChartPNG(type, vizData, overridesFor(type));
      // Graceful fallback: never embed a blank/half-loaded map. Keep the dialog open
      // with a clear message so the user can retry or pick a different chart.
      if (!png) {
        showToast(isMap
          ? "Couldn't capture the map — try again, or pick a chart for the report"
          : "Couldn't render that chart for the report");
        return;
      }
      closeExportDialog();
      const args = { title, analysis, headlineSegments: headlineSegments || [], type, png };
      if (fmt === 'pdf') await exportPdf(args);
      else if (fmt === 'ppt') await exportPptx(args);
      else if (fmt === 'word') await exportDocx(args);
      else if (fmt === 'png') await exportPng(args);
    });
    fmtRow.appendChild(b);
  });
  body.appendChild(fmtRow);

  // Dismiss: backdrop click + Esc; Tab is trapped within the dialog.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeExportDialog(); });
  _exportEscape = (e) => {
    if (e.key === 'Escape') closeExportDialog();
    else if (_exportA11y) _exportA11y.onTabKey(e);
  };
  document.addEventListener('keydown', _exportEscape, true);

  document.body.appendChild(overlay);
  // Dialog semantics + move focus into the modal (close button) + focus return on close.
  _exportA11y = makeModalAccessible(dialog, 'Export report', closeBtn);
  requestAnimationFrame(() => picker.select(picker.getSelected()));
}
