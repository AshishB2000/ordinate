// Serves the built web app (web/dist) from the API's own origin, so the
// session cookie and the CSP's 'self' cover both. Hashed files under assets/
// are immutable; index.html is revalidated every time, so a deploy is picked
// up on the next navigation.
//
// Client-side routes (/data, /visuals/…) have no file: a browser navigation
// (Accept: text/html) to anything that is not a file gets index.html and
// React Router takes it from there. Everything else that misses — /api/*, a
// missing .js — stays a real 404, never an HTML page a script would choke on.

import * as path from 'path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Where `npm --prefix web run build` writes the app. */
export const WEB_DIST = path.join(__dirname, '..', '..', 'web', 'dist');

export function registerStatic(app: FastifyInstance, root: string): void {
  void app.register(fastifyStatic, {
    root,
    cacheControl: false,
    setHeaders: (reply, file) => {
      const immutable = path.relative(root, file).startsWith('assets' + path.sep);
      reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app.setNotFoundHandler((req, reply) => {
    const page = req.method === 'GET' && !req.url.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html');
    if (page) return reply.sendFile('index.html'); // no-cache, via setHeaders
    return reply.code(404).send({ error: 'not found' });
  });
}
