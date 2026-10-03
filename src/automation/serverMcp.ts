// MCP on the server — `POST /api/mcp` with a personal API token (T3.4). The
// same protocol layer as the desktop's loopback transport (mcp.ts) and the
// same command registry, behind the server's own sign-in instead of a
// per-launch token on 127.0.0.1.
//
// Gates, in order:
//   1. Signed in by `Authorization: Bearer ord_…` (src/server/auth/tokens.ts)
//      — 401 otherwise. A browser session or dev sign-in is NOT enough: this
//      is the door for programs, and it never rides a cookie.
//   2. An Origin, when present, must be this server's own (403): a page on
//      another site that somehow holds a token still says where it is.
//   3. POST only (GET → 405: no server-to-client stream is offered), a body
//      cap of MAX_BODY (413), JSON (JSON-RPC parse error), no batches.
//
// Then every tool call runs AS the token's user: projects they cannot read
// do not exist for them (a list is trimmed, a name or id is "not found"), and
// a command that writes records needs editor on its project — the same rule
// (src/server/authz/) every RPC contract goes through. Write calls are audited
// as channel `mcp:<tool>`. Two tools are desktop-only (they render through an
// Electron window) and are not offered here.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ProjectScoped } from '../api/contract';
import { audit, type Outcome } from '../server/authz/audit';
import { authorize, readable } from '../server/authz/index';
import { ctx } from '../server/context';
import { sameOrigin } from '../server/csrf';
import { MAX_BODY } from './httpTransport';
import { createHandler, RPC, rpcError } from './mcp';
import * as registry from './registry';

/** Tools that draw through an Electron BrowserWindow (PDF/PNG capture, the report renderer). */
const DESKTOP_ONLY = new Set(['export_dashboard', 'run_report']);
export const SERVER_COMMANDS: readonly registry.Command[] = registry.COMMANDS.filter((c) => c.tool && !DESKTOP_ONLY.has(c.tool));

const version = (): string => (require('../../package.json') as { version: string }).version;

export function registerMcpRoute(app: FastifyInstance, pool: () => Pool | null): void {
  // Inside its own plugin, so the raw-text JSON parser (for a JSON-RPC parse
  // error instead of Fastify's) and the body cap apply to this route only.
  void app.register(async (mcp) => {
    mcp.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

    mcp.get('/api/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST.' }));

    mcp.post('/api/mcp', { bodyLimit: MAX_BODY }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const who = ctx();
      if (who.via !== 'token') {
        return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Use a personal API token: Authorization: Bearer <token>.' });
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !sameOrigin(origin, req.headers.host)) return reply.code(403).send({ error: 'Forbidden origin.' });

      let msg: unknown;
      try {
        msg = JSON.parse(String(req.body ?? ''));
      } catch {
        return reply.code(400).send(rpcError(null, RPC.parse, 'Parse error'));
      }
      if (Array.isArray(msg)) return reply.code(400).send(rpcError(null, RPC.invalidRequest, 'Batches are not supported.'));

      const db = pool();
      const canRead = await readable(db, who);
      const handle = createHandler(
        {
          commands: SERVER_COMMANDS,
          transport: 'http',
          headless: true,
          version: version(),
          dispatch: async (cmd, raw, o) => {
            let projectId: string | null = null;
            let outcome: Outcome = 'error';
            const scope: registry.Scope = {
              canRead,
              allow: async (c, id) => {
                projectId = id;
                const check: ProjectScoped = { access: c.readOnly ? 'read' : 'write', input: z.unknown(), project: () => id };
                const yes = (await authorize(check, null, who, db)).ok;
                if (!yes) outcome = 'denied';
                return yes;
              },
            };
            try {
              const out = await registry.dispatch(cmd, raw, { ...o, scope });
              outcome = 'ok';
              return out;
            } finally {
              if (!cmd.readOnly) {
                await audit(db, {
                  org: who.org.id, actor: who.user.email, action: 'rpc', channel: `mcp:${cmd.tool}`,
                  projectId, outcome, requestId: who.requestId,
                }).catch((err: unknown) => req.log.error({ err: { name: (err as Error | null)?.name }, tool: cmd.tool }, 'audit write failed'));
              }
            }
          },
        },
        registry.inputSchema,
      );
      const out = await handle(msg);
      return out ? reply.send(out) : reply.code(202).send();
    });
  });
}
