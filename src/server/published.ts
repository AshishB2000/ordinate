// GET /p/<publishId>/<page> — a published site (T2.9, src/publish/hosted.ts).
//
// WHO MAY OPEN IT:
//   1. a signed-in member of the org that published it — every site, whatever
//      its access (`org` is the default);
//   2. anyone, signed in or not, when the site is `link` AND its org's admin has
//      turned public links on (org_settings.public_links, off by default). The
//      setting is read on every request, so turning it off closes every
//      `link` site at once without touching them;
//   3. nobody else: a signed-out visitor is sent to sign in, a signed-in
//      non-member gets the same 404 as a site that does not exist — no probe
//      can tell "exists elsewhere" from "never existed".
// A site whose project has been deleted is not served either.
//
// THE PAGE'S OWN CSP. Every page pins its inline scripts and stylesheet by
// SHA-256 in a <meta> (src/publish/siteHtml.ts); the app's header CSP
// (script-src 'self') would refuse those very scripts, so this route sends the
// page's policy as the header instead — the same directives, plus
// frame-ancestors 'none', which only a header can carry. Nothing else about
// the page changes: it was sanitized when it was published.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { runInContext, type Identify, type Identity } from './context';
import { getPage, getSite, PAGE_RE, type HostedSite } from '../publish/hosted';
import { isValidId } from '../app/ids';

/** The policy a page pinned in its <meta>, or null. */
export function pageCsp(html: string): string | null {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  return m ? m[1] : null;
}

/** The orgs whose admin allows public links (none without Postgres: there is no setting to turn on). */
async function publicOrgs(pool: Pool | null): Promise<string[]> {
  if (!pool) return [];
  const r = await pool.query<{ org_id: string }>('SELECT org_id FROM org_settings WHERE public_links');
  return r.rows.map((x) => x.org_id);
}

/** Does `org` allow public links right now? */
export async function orgAllowsLinks(pool: Pool | null, org: string): Promise<boolean> {
  if (!pool) return false;
  const r = await pool.query<{ on: boolean }>('SELECT public_links AS on FROM org_settings WHERE org_id = $1', [org]);
  return r.rows[0]?.on === true;
}

const anonymous = (org: string): Identity => ({ user: { email: 'anonymous', role: 'viewer' }, org: { id: org } });

/** The site and page as `who` (or, when null, the public) may see them. */
async function find(pool: Pool | null, who: Identity | null, id: string, file: string, reqId: string): Promise<string | null> {
  const read = (as: Identity, allow: (s: HostedSite) => boolean | Promise<boolean>) =>
    runInContext(as, reqId, async () => {
      const site = await getSite(id);
      if (!site || !(await allow(site))) return null;
      const projects = require('../app/projects') as typeof import('../app/projects');
      if (!(await projects.getProject(site.projectId))) return null;
      return getPage(id, file);
    });
  if (who) {
    const own = await read(who, () => true);
    if (own !== null) return own;
  }
  for (const org of await publicOrgs(pool)) {
    if (who && org === who.org.id) continue; // already looked: a member sees it above or not at all
    const html = await read(anonymous(org), (s) => s.access === 'link');
    if (html !== null) return html;
  }
  return null;
}

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head>
<body><p>This published link does not exist, or you cannot open it.</p></body></html>`;

export function registerPublishedRoutes(app: FastifyInstance, identify: Identify, pool: () => Pool | null): void {
  const serve = async (req: FastifyRequest, reply: FastifyReply, id: string, file: string) => {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    if (!isValidId(id) || !PAGE_RE.test(file)) return reply.code(404).type('text/html').send(NOT_FOUND);
    const who = await identify(req.headers, req.socket.remoteAddress);
    const html = await find(pool(), who, id, file, String(req.id));
    if (html === null) {
      if (!who) return reply.redirect(`/sign-in?next=${encodeURIComponent(req.url.split('?')[0])}`);
      return reply.code(404).type('text/html').send(NOT_FOUND);
    }
    const csp = pageCsp(html);
    if (!csp) return reply.code(500).type('text/html').send(NOT_FOUND); // not a page we built
    return reply.header('content-security-policy', `${csp}; frame-ancestors 'none'`).type('text/html; charset=utf-8').send(html);
  };
  // The bare link gets a trailing slash, so the site's relative links (index → page → index) resolve under it.
  app.get<{ Params: { id: string } }>('/p/:id', (req, reply) => reply.redirect(`/p/${encodeURIComponent(req.params.id)}/`));
  app.get<{ Params: { id: string } }>('/p/:id/', (req, reply) => serve(req, reply, req.params.id, 'index.html'));
  app.get<{ Params: { id: string; file: string } }>('/p/:id/:file', (req, reply) => serve(req, reply, req.params.id, req.params.file));
}
