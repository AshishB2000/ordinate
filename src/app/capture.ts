// The only nontrivial logic in this slice: grab a full-screen "frozen frame"
// and crop it to a CSS-pixel rectangle the overlay reports back.
//
// All of this runs in the MAIN process — desktopCapturer is main-process only
// since Electron 17, and we keep nativeImage handling out of the renderers.

import { desktopCapturer, screen } from 'electron';
import type { Display, NativeImage, DesktopCapturerSource } from 'electron';

// Capture the full primary display as a nativeImage.
//
// thumbnailSize must be in DEVICE pixels, so we scale the CSS size by the
// display's scaleFactor (e.g. 2 on Retina, 1.5 at Windows 150%). Some platforms
// still hand back a different resolution than requested, so callers must read
// the ACTUAL size off the returned image rather than trusting this request.
export async function captureFrozenFrame(display: Display): Promise<NativeImage> {
  const { width, height } = display.size; // CSS px
  const sf = display.scaleFactor || 1;

  // desktopCapturer.getSources can hang indefinitely in a packaged macOS app
  // when Screen Recording permission isn't truly active — surface it as an error
  // instead of a silent dead capture (no overlay, no message).
  const getSources = desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * sf),
      height: Math.round(height * sf),
    },
  });
  const timeout = new Promise<never>((_r, reject) =>
    setTimeout(() => reject(new Error('desktopCapturer.getSources timed out (10s) — Screen Recording permission may not be active for this app.')), 10000)
  );

  // getSources can REJECT (not just resolve empty) when screen capture is
  // unavailable — and the rejection sometimes carries no .message. Normalize it
  // so the failure is always legible instead of "undefined".
  let sources: DesktopCapturerSource[];
  try {
    sources = await Promise.race([getSources, timeout]);
  } catch (e: any) {
    const why = (e && (e.message || e.toString())) || String(e) || 'unknown error';
    throw new Error('desktopCapturer.getSources failed: ' + why);
  }
  console.log('[capture] desktopCapturer returned', sources.length, 'source(s)');

  if (!sources.length) {
    throw new Error('No screen sources returned by desktopCapturer (Screen Recording is likely off for this app).');
  }

  // Prefer the source matching this display; fall back to the first (single-display scope).
  const match = sources.find((s) => s.display_id === String(display.id));
  const source = match || sources[0];
  return source.thumbnail; // nativeImage
}

// Crop the frozen frame to a rectangle given in CSS pixels (overlay coordinates).
//
// We derive the device-pixel ratio from the frame's ACTUAL size vs the display's
// CSS size, so it stays correct whether the capture came back at 1x or 2x.
// Returns a cropped nativeImage, or null for a zero-area / out-of-bounds selection.
export function cropToRect(
  frame: NativeImage,
  cssRect: { x: number; y: number; w: number; h: number },
  display: Display
): NativeImage | null {
  const actual = frame.getSize(); // ACTUAL device px of the captured bitmap
  const rx = actual.width / display.size.width;
  const ry = actual.height / display.size.height;

  let x = Math.round(cssRect.x * rx);
  let y = Math.round(cssRect.y * ry);
  let w = Math.round(cssRect.w * rx);
  let h = Math.round(cssRect.h * ry);

  // Clamp to the captured bitmap.
  x = Math.max(0, Math.min(x, actual.width));
  y = Math.max(0, Math.min(y, actual.height));
  w = Math.max(0, Math.min(w, actual.width - x));
  h = Math.max(0, Math.min(h, actual.height - y));

  if (w < 1 || h < 1) return null; // click without a real drag

  return frame.crop({ x, y, width: w, height: h });
}

// Convenience: the display the capture loop operates on (single primary display).
export function getPrimaryDisplay(): Display {
  return screen.getPrimaryDisplay();
}

// The display the user is currently pointing at — the correct overlay target on
// multi-monitor setups. The primary display is NOT necessarily where the user is
// looking (e.g. attention on an external ultrawide while the laptop is primary),
// so the capture overlay must follow the cursor's display, whose .bounds may have
// a negative/offset origin relative to the primary.
export function getActiveDisplay(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
