// Security headers on EVERY response (T6.2): the app's HTML, its static files,
// every /api/ route (RPC, files, the event stream, sign-in, MCP), the probes,
// errors and 404s.
//
// The CSP lives here, as a response header, and nowhere else — the web build
// no longer emits a <meta> (frame-ancestors only works in a header, and two
// policies would have to be kept in step). Everything outside /api/ — the
// app's document, its client-side routes and its own static files — gets
// APP_CSP; everything under /api/ (JSON, user files, the event stream) gets
// API_CSP, which allows nothing: a response opened directly in a tab can run
// no script. Decided by the PATH, never the response type: a 304 revalidating
// index.html has no content-type, and the browser merges the 304's headers
// into the cached page — a type-based rule would hand the app API_CSP there.
//
// APP_CSP is what the built app needs and no more: the Vite build emits only
// external <script type="module"> and <link rel="stylesheet"> (no inline
// script or style; the theme is set by the external /theme-boot.js), charts
// draw on canvas, and React sets styles through the CSSOM, which style-src
// does not govern. The e2e harness fails on any CSP violation, so a build
// that starts to need more fails there first.

import type { FastifyInstance } from 'fastify';

/**
 * Map tile servers (T1.3), e.g. 'https://tile.openstreetmap.org'. The ONE
 * place a map host is allowed: added to img-src and connect-src. Empty until
 * maps ship — no other external host may be fetched (CLAUDE.md: no surprise
 * network calls).
 */
// OpenStreetMap's raster tile hosts (T1.3): the ONE declared external fetch, made only
// when a map with the OSM basemap is on screen. MapLibre fetches tiles (connect-src)
// and decodes them as images (img-src). Nothing else external is allowed anywhere.
export const MAP_TILE_ORIGINS: readonly string[] = ['a', 'b', 'c'].map((h) => `https://${h}.tile.openstreetmap.org`);

const tiles = MAP_TILE_ORIGINS.map((o) => ' ' + o).join('');

/** The web app's document (index.html and every client-side route). */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' data:${tiles}`,
  "font-src 'self'",
  `connect-src 'self'${tiles}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Everything under /api/: nothing may load, nothing may frame it. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The fixed headers. Referrer-Policy keeps paths and queries (record ids, a
 * `next=`) on this origin; a cross-origin request carries the origin only,
 * which a tile server's usage policy asks for (T1.3). Permissions-Policy turns
 * off every powerful feature the app never uses; only features browsers
 * recognise are listed — an unknown one is a console error, which e2e fails.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': API_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), fullscreen=(self)',
});

/** One year, every subdomain. Not `preload`: that is the operator's call for their domain. */
export const HSTS = 'max-age=31536000; includeSubDomains';

/**
 * Adds the headers to every response. Set at onRequest, so a reply that ends
 * early (401, 403, 429, 304, a redirect, a thrown error) has them too, and the
 * event stream copies them into its own writeHead (./sse.ts). HSTS only in
 * prod: on a dev server over plain http it would pin localhost to https.
 */
export function registerSecurityHeaders(app: FastifyInstance, prod: boolean): void {
  app.addHook('onRequest', (req, reply, done) => {
    reply.headers(SECURITY_HEADERS);
    if (!req.url.startsWith('/api/')) reply.header('content-security-policy', APP_CSP);
    if (prod) reply.header('strict-transport-security', HSTS);
    done();
  });
}
