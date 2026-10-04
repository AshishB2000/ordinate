// A screenshot, readied for the model in the browser: any image the browser
// can decode becomes a PNG (the provider adapters send PNG — src/ai/analyze.ts)
// no longer than MAX_EDGE on its long side (providers downscale larger ones
// anyway, so the upload stays small), plus a small JPEG thumbnail for the
// Captures list (the server keeps the crop; a browser cannot read its path).
// Pixels only — no figure is computed here.

export const MAX_EDGE = 2000;
const THUMB_W = 360;
const THUMB_H = 400;

export interface ReadyImage {
  png: Blob;
  thumb: string;
}

function canvasOf(img: ImageBitmap, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** Rejects with a sentence when the file is not an image the browser can open. */
export async function readyImage(file: Blob): Promise<ReadyImage> {
  let img: ImageBitmap;
  try {
    img = await createImageBitmap(file);
  } catch {
    throw new Error('That file is not an image this browser can open. Use a PNG, JPEG, WebP or GIF screenshot.');
  }
  try {
    const big = canvasOf(img, Math.min(1, MAX_EDGE / Math.max(img.width, img.height)));
    const png = await new Promise<Blob | null>((r) => big.toBlob(r, 'image/png'));
    if (!png) throw new Error('The screenshot could not be prepared for upload.');
    const thumb = canvasOf(img, Math.min(1, THUMB_W / img.width, THUMB_H / img.height)).toDataURL('image/jpeg', 0.72);
    return { png, thumb };
  } finally {
    img.close();
  }
}
