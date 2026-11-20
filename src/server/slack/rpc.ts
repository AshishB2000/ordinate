// Slack's RPC channels (contracts in src/api/slack.ts): the admin's setup, the member's own link, the channel picker and
// an agent's channels. Replies carry has-key flags, ids and names only: a key never leaves the secrets store.

import { ipcMain } from '../../ipc/bus';
import { readAgent } from '../../ai/agents';
import { ctx } from '../context';
import { authTest, botChannels, SlackApiError } from './client';
import * as store from './db';
import { manifestFor, serverOrigin } from './manifest';
import { mayAsk } from './ask';
import { appPool } from '../app';

const noDb = { ok: false as const, error: 'Slack needs Postgres (DATABASE_URL).' };
const view = async (i: store.Install) => ({
  teamId: i.teamId, teamName: i.teamName, mode: i.mode, enabled: i.enabled, allowGuests: i.allowGuests, allowShareOverride: i.allowShareOverride, botUserId: i.botUserId, clientId: i.clientId,
  hasBotToken: !!(await store.getSecret(i.orgId, 'botToken')), hasSigningSecret: !!(await store.getSecret(i.orgId, 'signingSecret')),
  hasClientSecret: !!(await store.getSecret(i.orgId, 'clientSecret')), hasAppToken: !!(await store.getSecret(i.orgId, 'appToken')),
});

export function register(): void {
  ipcMain.handle('slack:status', async () => {
    if (!store.dbOrNull()) return noDb;
    const install = await store.installByOrg(ctx().org.id);
    const manifests = { events: manifestFor('events'), socket: manifestFor('socket') };
    return {
      ok: true, canSave: store.canStoreSecrets(), publicUrl: serverOrigin(), install: install ? await view(install) : null,
      linked: install ? (await store.allLinks(ctx().org.id)).length : 0,
      manifest: { events: manifests.events && JSON.stringify(manifests.events, null, 2), socket: JSON.stringify(manifests.socket, null, 2) },
    };
  });

  ipcMain.handle('slack:install', async (_e, p: { botToken: string; signingSecret?: string; clientId?: string; clientSecret?: string; appToken?: string; mode: 'events' | 'socket' }) => {
    if (!store.dbOrNull()) return noDb;
    if (!store.canStoreSecrets()) return { ok: false, error: 'Saving Slack keys needs ORDINATE_MASTER_KEY on the server.' };
    const org = ctx().org.id;
    const had = await store.installByOrg(org);
    const signing = p.signingSecret || (await store.getSecret(org, 'signingSecret'));
    const appToken = p.appToken || (await store.getSecret(org, 'appToken'));
    if (p.mode === 'events' && !signing) return { ok: false, error: 'Paste the app\'s signing secret.' };
    if (p.mode === 'socket' && !appToken) return { ok: false, error: 'Socket Mode needs the app-level token (xapp-…).' };
    if (p.mode === 'events' && !serverOrigin()) return { ok: false, error: 'Slack cannot reach this server: set ORDINATE_PUBLIC_URL, or choose Socket Mode.' };
    let who;
    try {
      who = await authTest(p.botToken);
    } catch (err) {
      return { ok: false, error: err instanceof SlackApiError ? 'Slack did not accept that bot token.' : 'Could not reach Slack.' };
    }
    const done = await store.saveInstall({
      teamId: who.teamId, orgId: org, teamName: who.teamName, enterpriseId: who.enterpriseId, appId: who.appId, botUserId: who.botUserId,
      clientId: p.clientId ?? had?.clientId ?? '', mode: p.mode,
    });
    if (done === 'taken') return { ok: false, error: 'That Slack workspace is connected to another organization on this server.' };
    await store.putSecret(org, 'botToken', p.botToken);
    if (p.signingSecret) await store.putSecret(org, 'signingSecret', p.signingSecret);
    if (p.clientSecret) await store.putSecret(org, 'clientSecret', p.clientSecret);
    if (p.appToken) await store.putSecret(org, 'appToken', p.appToken);
    return { ok: true, install: await view((await store.installByOrg(org)) as store.Install) };
  });

  ipcMain.handle('slack:uninstall', async () => {
    if (!store.dbOrNull()) return noDb;
    const org = ctx().org.id;
    const i = await store.installByOrg(org);
    if (i) await store.wipeTeam(org, i.teamId);
    await store.dropSecrets(org);
    return { ok: true };
  });

  ipcMain.handle('slack:settings', async (_e, p: { mode?: 'events' | 'socket'; allowGuests?: boolean; allowShareOverride?: boolean; enabled?: boolean }) => {
    if (!store.dbOrNull()) return noDb;
    const org = ctx().org.id;
    if (!(await store.installByOrg(org))) return { ok: false, error: 'Connect Slack first.' };
    if (p.mode === 'socket' && !(await store.getSecret(org, 'appToken'))) return { ok: false, error: 'Socket Mode needs the app-level token (xapp-…): save it first.' };
    if (p.mode === 'events' && !serverOrigin()) return { ok: false, error: 'Slack cannot reach this server: set ORDINATE_PUBLIC_URL, or stay on Socket Mode.' };
    await store.setSettings(org, p);
    return { ok: true, install: await view((await store.installByOrg(org)) as store.Install) };
  });

  ipcMain.handle('slack:links', async () => (store.dbOrNull() ? { ok: true, links: await store.allLinks(ctx().org.id) } : noDb));

  ipcMain.handle('slack:myLink', async () => {
    if (!store.dbOrNull()) return { ok: true, available: false, links: [] };
    const { org, user } = ctx();
    const install = await store.installByOrg(org.id);
    return { ok: true, available: !!install?.enabled, teamName: install?.teamName ?? '', links: await store.myLinks(org.id, user.email) };
  });

  ipcMain.handle('slack:unlink', async () => {
    if (!store.dbOrNull()) return noDb;
    const { org, user } = ctx();
    return { ok: true, removed: await store.deleteLinksOf(org.id, user.email) };
  });

  ipcMain.handle('slack:openQuestion', async (_e, { id }: { id: string }) => {
    if (!store.dbOrNull()) return noDb;
    const { org, user } = ctx();
    const q = await store.questionById(org.id, id);
    const missing = { ok: false, error: 'That Slack question is no longer there.' };
    if (!q || q.kind !== 'ask') return missing;
    const asker = await store.linkedEmail(org.id, q.teamId, q.slackUserId);
    const mine = asker === user.email;
    const pool = appPool();
    const projectId = q.projectId;
    if (!projectId || !pool || !(await mayAsk(pool, ctx(), projectId))) return missing;
    // The asker lands on their conversation. Anyone else gets the words of a CHANNEL question to ask again as themselves
    // (a direct message stays private to its asker).
    if (mine) return { ok: true, mine: true, projectId, threadId: q.threadId, question: q.text };
    return q.channelType === 'channel' ? { ok: true, mine: false, projectId, threadId: null, question: q.text } : missing;
  });

  ipcMain.handle('slack:channels', async () => { // the contract scopes it to a project admin; the picker lists the workspace's channels
    if (!store.dbOrNull()) return noDb;
    const org = ctx().org.id;
    const install = await store.installByOrg(org);
    const token = install?.enabled ? await store.getSecret(org, 'botToken') : null;
    if (!install || !token) return { ok: true, connected: false, channels: [] };
    try {
      const list = [];
      for (const c of await botChannels(token)) {
        const ca = await store.channelAgent(install.teamId, c.id);
        const mine = ca && ca.orgId === org ? ca : null;
        list.push({ ...c, agentId: mine?.agentId ?? null, projectId: mine?.projectId ?? null });
      }
      return { ok: true, connected: true, channels: list };
    } catch {
      return { ok: false, error: 'Could not read the channels from Slack.' };
    }
  });

  ipcMain.handle('agent:slackChannels', async (_e, { projectId, agentId, channels }: { projectId: string; agentId: string; channels?: Array<{ id: string }> }) => {
    if (!store.dbOrNull()) return noDb;
    const org = ctx().org.id;
    if (!(await readAgent(projectId, agentId))) return { ok: false, error: 'That agent is no longer there.' };
    const install = await store.installByOrg(org);
    if (channels !== undefined) {
      const token = install?.enabled ? await store.getSecret(org, 'botToken') : null;
      if (!install || !token) return { ok: false, error: 'Slack is not connected: an org admin sets it up in Admin.' };
      let inBot;
      try {
        inBot = new Map((await botChannels(token)).map((c) => [c.id, c.name] as const));
      } catch {
        return { ok: false, error: 'Could not read the channels from Slack.' };
      }
      const wanted = [...new Set(channels.map((c) => c.id))];
      if (wanted.some((id) => !inBot.has(id))) return { ok: false, error: 'Invite @Ordinate to a channel in Slack before choosing it.' };
      await store.setAgentChannels(org, install.teamId, projectId, agentId, wanted.map((id) => ({ id, name: inBot.get(id) as string })));
    }
    return { ok: true, connected: !!install?.enabled, channels: await store.channelsOfAgent(org, projectId, agentId) };
  });
}
