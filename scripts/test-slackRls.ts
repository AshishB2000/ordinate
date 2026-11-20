// Ordinate in Slack: row-level security on the Slack tables (0041_slack.sql). As an ORDINARY role (a superuser skips RLS, so
// the other suites cannot see it): a statement with no scope sees no row; the org's scope sees the org's; a workspace's
// scope that workspace's; a Connect button's scope that one row; `system` all; a write for another org is refused. Then the
// store's own functions run through that role, which proves they name their scope (src/server/slack/db.ts `scoped`).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-slackRls.js

export {}; // module scope — sibling test scripts share top-level names
import { Pool } from 'pg';
import { ok, finish } from './selfcheck';
import { slackWorld } from './slackHarness';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');

(async () => {
  const S = await slackWorld('slack rls');
  if (!S) return;
  const { W } = S;
  const url = new URL((W.pool as unknown as { options: { connectionString: string } }).options.connectionString);
  let restricted: Pool | null = null;
  try {
    await W.pool.query(`DROP ROLE IF EXISTS slack_rls`).catch(() => undefined);
    await W.pool.query(`CREATE ROLE slack_rls LOGIN`);
    await W.pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO slack_rls`);
    await W.pool.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO slack_rls`);
    url.username = 'slack_rls';
    url.password = '';
    restricted = new Pool({ connectionString: url.toString(), max: 3 });
    restricted.on('error', () => undefined);

    // Two orgs' rows in every table (as the superuser).
    await W.pool.query(`INSERT INTO slack_installs (team_id, org_id, bot_user_id) VALUES ('TOTHER', 'other', 'UB2')`);
    await W.pool.query(`INSERT INTO slack_links (org_id, team_id, slack_user_id, user_email) VALUES ('acme', 'T001', 'UA', 'a@acme.test'), ('other', 'TOTHER', 'UO', 'o@other.test')`);
    await W.pool.query(`INSERT INTO slack_link_states (token_hash, org_id, team_id, slack_user_id, nonce, expires_at) VALUES ('hash-acme', 'acme', 'T001', 'UA', 'n', now() + interval '1 hour'), ('hash-other', 'other', 'TOTHER', 'UO', 'n', now() + interval '1 hour')`);
    await W.pool.query(`INSERT INTO slack_questions (id, org_id, team_id, channel_id, slack_user_id, text) VALUES (gen_random_uuid(), 'acme', 'T001', 'C1', 'UA', 'mine'), (gen_random_uuid(), 'other', 'TOTHER', 'C1', 'UO', 'theirs')`);
    await W.pool.query(`INSERT INTO slack_threads (team_id, channel_id, thread_ts, org_id, project_id, thread_id, asker_email) VALUES ('T001', 'C1', '1.1', 'acme', gen_random_uuid(), gen_random_uuid(), 'a@acme.test'), ('TOTHER', 'C1', '1.1', 'other', gen_random_uuid(), gen_random_uuid(), 'o@other.test')`);
    await W.pool.query(`INSERT INTO slack_channel_agents (team_id, channel_id, org_id, project_id, agent_id) VALUES ('T001', 'C9', 'acme', gen_random_uuid(), gen_random_uuid()), ('TOTHER', 'C9', 'other', gen_random_uuid(), gen_random_uuid())`);

    const TABLES = ['slack_installs', 'slack_links', 'slack_link_states', 'slack_questions', 'slack_threads', 'slack_channel_agents'];
    const seen = async (settings: Record<string, string>, table: string): Promise<number> => {
      const c = await (restricted as Pool).connect();
      try {
        await c.query('BEGIN');
        for (const [k, v] of Object.entries(settings)) await c.query('SELECT set_config($1, $2, true)', [k, v]);
        const n = Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
        await c.query('ROLLBACK');
        return n;
      } finally {
        c.release();
      }
    };
    const total = async (table: string) => Number((await W.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    for (const t of TABLES) {
      const all = await total(t);
      ok(`${t}: (control) the superuser sees both orgs' rows`, all >= 2, String(all));
      ok(`${t}: an ordinary role with NO scope sees no row`, (await seen({}, t)) === 0);
      ok(`${t}: the org's scope sees only the org's rows`, (await seen({ 'ordinate.org': 'acme' }, t)) > 0 && (await seen({ 'ordinate.org': 'acme' }, t)) < all);
      ok(`${t}: a workspace's scope sees only that workspace's rows`, (await seen({ 'ordinate.slack_team': 'TOTHER' }, t)) > 0 && (await seen({ 'ordinate.slack_team': 'TOTHER' }, t)) < all);
      ok(`${t}: the system scope sees every org's`, (await seen({ 'ordinate.slack_scope': 'system' }, t)) === all);
    }
    ok('slack_link_states: a Connect button\'s own hash sees that one row, nothing else', (await seen({ 'ordinate.slack_state': 'hash-acme' }, 'slack_link_states')) === 1 && (await seen({ 'ordinate.slack_state': 'nope' }, 'slack_link_states')) === 0);
    const c = await restricted.connect();
    let refused = false;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('ordinate.org', 'acme', true)`);
      await c.query(`INSERT INTO slack_links (org_id, team_id, slack_user_id, user_email) VALUES ('other', 'TOTHER', 'UX', 'x@other.test')`);
    } catch {
      refused = true;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    ok('a write for ANOTHER org under the org\'s scope is refused', refused);

    // The store's functions through the ordinary role.
    store.useSlackDb(restricted, S.secrets);
    await store.saveLink('acme', 'T001', 'UNEW', 'new@acme.test');
    ok('store: saveLink / linkedEmail / linkedAmong work as an ordinary role, each in its scope', (await store.linkedEmail('acme', 'T001', 'UNEW')) === 'new@acme.test' && (await store.linkedAmong('acme', 'T001', ['UNEW', 'UA'])).size === 2 && !(await store.linkedEmail('other', 'TOTHER', 'UNEW')));
    ok('store: another org\'s link is not readable through this org\'s call', !(await store.linkedEmail('acme', 'TOTHER', 'UO')) && (await store.linkedEmail('other', 'TOTHER', 'UO')) === 'o@other.test');
    const id = '99999999-9999-4999-8999-999999999999';
    ok('store: enqueue, then the worker\'s claim (system scope), then finish', (await store.enqueue({ id, orgId: 'acme', teamId: 'T001', channelId: 'C2', channelType: 'channel', threadTs: null, eventTs: '2.2', slackUserId: 'UA', text: 'rls question' }, 'EvRls1')) === true
      && (await store.enqueue({ id: '99999999-9999-4999-8999-999999999998', orgId: 'acme', teamId: 'T001', channelId: 'C2', channelType: 'channel', threadTs: null, eventTs: '2.2', slackUserId: 'UA', text: 'dup' }, 'EvRls1')) === false);
    const claimed = await store.claim('rls-pod');
    ok('store: claim sees queued questions of every org', claimed?.text === 'mine' || claimed?.text === 'theirs' || claimed?.text === 'rls question', claimed?.text);
    if (claimed) await store.finish(claimed.id, 'rls-pod', 'done', 'x');
    const token = await store.newState('acme', 'T001', 'UA', null);
    ok('store: a Connect state is made in the org\'s scope, bound, and consumed by its token alone (no org named)', !!(await store.bindState(token, 'acme', 'a@acme.test')) && !!(await store.consumeState(token)) && (await store.consumeState(token)) === null);
    ok('store: installByTeam / installByOrg / channelAgent / threadOf read their own scope', (await store.installByTeam('T001'))?.orgId === 'acme' && (await store.installByOrg('other'))?.teamId === 'TOTHER' && (await store.channelAgent('T001', 'C9'))?.orgId === 'acme' && !!(await store.threadOf('T001', 'C1', '1.1')));
    await store.sweep('acme').then(() => ok('store: the sweep (several scopes, and assistant_threads under the same setting) runs', true), (e) => ok('store: the sweep runs', false, String(e)));
  } finally {
    store.useSlackDb(W.pool, S.secrets);
    await restricted?.end();
    await W.pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM slack_rls`).catch(() => undefined);
    await W.pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM slack_rls`).catch(() => undefined);
    await W.pool.query(`DROP ROLE IF EXISTS slack_rls`).catch(() => undefined);
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
