// Admin → Projects, Audit log and Settings (T3.4). Org admins only (the route
// checks, src/api/admin.ts); every statement is confined to the caller's org.
//
//   projects   every project of the org with its owner team; ownership moves
//              to another team in one transaction (the previous owner team
//              keeps an ordinary admin grant — nobody loses access silently)
//   audit      T3.3's audit_log, filtered, newest first, keyset-paged by id.
//              A row holds ids and names of channels, never a value.
//   settings   public links, allowed AI providers, a per-org upload cap that
//              POST /api/files enforces under MAX_UPLOAD_MB (uploadCapMb()).

import type { Pool } from 'pg';
import { AI_PROVIDERS } from '../../api/admin';
import { ctx } from '../context';
import { registry } from '../rpc';

const PAGE = 50;

export interface AuditRow {
  readonly id: number;
  readonly at: string;
  readonly actor: string | null;
  readonly action: string;
  readonly channel: string | null;
  readonly projectId: string | null;
  readonly targets: string[];
  readonly outcome: string;
  readonly requestId: string | null;
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  channel?: string;
  projectId?: string;
  from?: string;
  to?: string;
  outcome?: string;
  before?: number;
  limit?: number;
}

export interface OrgSettings {
  readonly publicLinks: boolean;
  readonly aiProviders: string[];
  readonly uploadCapMb: number | null;
  /** The server's ceiling (MAX_UPLOAD_MB): a per-org cap may only be lower. */
  readonly maxUploadMb: number;
  /** Every provider an org can allow. */
  readonly providers: readonly string[];
}

/** `%`, `_` and `\` matched literally inside an ILIKE pattern. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** The upload cap for `org` in MB: its own cap when set and lower, else the server's. */
export async function uploadCapMb(pool: Pool | null, org: string, ceiling: number): Promise<number> {
  if (!pool) return ceiling;
  const r = await pool.query<{ cap: number | null }>('SELECT upload_cap_mb AS cap FROM org_settings WHERE org_id = $1', [org]);
  const cap = r.rows[0]?.cap;
  return cap && cap < ceiling ? cap : ceiling;
}

/** `maxUploadMb()`: MAX_UPLOAD_MB, read per call. */
export function register(pool: () => Pool | null, maxUploadMb: () => number): void {
  const db = (): Pool => {
    const p = pool();
    if (!p) throw new Error('admin needs Postgres (DATABASE_URL)');
    return p;
  };
  const org = () => ctx().org.id;
  const projects = () => require('../../app/projects') as typeof import('../../app/projects');

  registry.handle('admin:projects', async () => {
    const list = await projects().listProjects();
    const owners = await db().query<{ project_id: string; id: string; name: string }>(
      `SELECT g.project_id, t.id, t.name FROM project_grants g JOIN teams t ON t.id = g.team_id WHERE g.org_id = $1 AND g.owner`,
      [org()],
    );
    const byProject = new Map(owners.rows.map((o) => [o.project_id, { id: o.id, name: o.name }]));
    return list
      .map((p) => ({ id: p.id, name: p.name, archived: Boolean(p.archivedAt), updatedAt: p.updatedAt, owner: byProject.get(p.id) ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  registry.handle('admin:transferOwner', async (_e, { projectId, teamId }: { projectId: string; teamId: string }) => {
    if (!(await projects().getProject(projectId))) return { ok: false, error: 'unknown project' };
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const team = await client.query('SELECT 1 FROM teams WHERE id = $1 AND org_id = $2', [teamId, org()]);
      if (team.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'unknown team' };
      }
      // The old owner keeps an admin grant; the partial unique index allows one owner at a time.
      await client.query('UPDATE project_grants SET owner = false WHERE org_id = $1 AND project_id = $2 AND owner', [org(), projectId]);
      await client.query(
        `INSERT INTO project_grants (org_id, project_id, team_id, role, owner) VALUES ($1, $2, $3, 'admin', true)
         ON CONFLICT (org_id, project_id, team_id) DO UPDATE SET role = 'admin', owner = true`,
        [org(), projectId, teamId],
      );
      await client.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  registry.handle('admin:audit', async (_e, f: AuditFilter = {}) => {
    const where = ['org_id = $1'];
    const args: unknown[] = [org()];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replaceAll('?', `$${args.length}`));
    };
    if (f.actor) add(`actor ILIKE ? ESCAPE '\\'`, `%${likeEscape(f.actor)}%`);
    if (f.action) add('action = ?', f.action);
    if (f.channel) add('channel = ?', f.channel);
    if (f.projectId) add('(project_id = ?::uuid OR ?::uuid = ANY(target_ids))', f.projectId);
    if (f.from) add('at >= ?::timestamptz', f.from);
    if (f.to) add('at < ?::timestamptz', f.to);
    if (f.outcome) add('outcome = ?', f.outcome);
    if (f.before) add('id < ?', f.before);
    const limit = f.limit ?? PAGE;
    args.push(limit + 1);
    const r = await db().query<AuditRow>(
      `SELECT id::int AS id, to_json(at) #>> '{}' AS at, actor, action, channel, project_id AS "projectId",
              target_ids::text[] AS targets, outcome, request_id AS "requestId"
         FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${args.length}`,
      args,
    );
    const rows = r.rows.slice(0, limit);
    // ponytail: DISTINCT over the org's whole trail for the channel picker; cap or cache it if the trail grows large.
    const channels = f.before
      ? undefined
      : (await db().query<{ c: string }>(`SELECT DISTINCT channel AS c FROM audit_log WHERE org_id = $1 AND channel IS NOT NULL ORDER BY 1 LIMIT 200`, [org()])).rows.map((x) => x.c);
    return { rows, next: r.rows.length > limit ? rows[rows.length - 1].id : null, ...(channels ? { channels } : {}) };
  });

  registry.handle('admin:settings', async (): Promise<OrgSettings> => {
    const r = await db().query<{ public_links: boolean; ai_providers: string[] | null; upload_cap_mb: number | null }>(
      'SELECT public_links, ai_providers, upload_cap_mb FROM org_settings WHERE org_id = $1',
      [org()],
    );
    const row = r.rows[0];
    return {
      publicLinks: row?.public_links ?? false,
      aiProviders: row?.ai_providers ?? [...AI_PROVIDERS],
      uploadCapMb: row?.upload_cap_mb ?? null,
      maxUploadMb: maxUploadMb(),
      providers: AI_PROVIDERS,
    };
  });

  registry.handle(
    'admin:saveSettings',
    async (_e, s: { publicLinks: boolean; aiProviders: string[]; uploadCapMb: number | null }) => {
      if (s.uploadCapMb !== null && s.uploadCapMb > maxUploadMb()) return { ok: false, error: 'cap' };
      const providers = AI_PROVIDERS.filter((p) => s.aiProviders.includes(p));
      await db().query(
        `INSERT INTO org_settings (org_id, public_links, ai_providers, upload_cap_mb, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (org_id) DO UPDATE SET public_links = $2, ai_providers = $3, upload_cap_mb = $4, updated_at = now()`,
        [org(), s.publicLinks, providers.length === AI_PROVIDERS.length ? null : providers, s.uploadCapMb],
      );
      return { ok: true };
    },
  );
}
