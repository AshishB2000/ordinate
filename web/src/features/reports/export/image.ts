// A picture's natural size, for an ImageRun's transformation and a logo's aspect.
// A PNG data URL (every picture the writers embed) is read from its IHDR header
// — no decode, no DOM; anything else (an SVG logo before it is rasterized)
// goes through an <img>.

export function pngSize(url: string): { w: number; h: number } | null {
  if (!url.startsWith('data:image/png;base64,')) return null;
  try {
    const head = atob(url.slice(22, 22 + 44)); // 33 bytes: signature + IHDR
    const u32 = (o: number) => ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) | (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0;
    if (head.slice(12, 16) !== 'IHDR') return null;
    return { w: u32(16), h: u32(20) };
  } catch {
    return null;
  }
}

export function imageSize(url: string): Promise<{ w: number; h: number } | null> {
  const png = pngSize(url);
  if (png) return Promise.resolve(png);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
