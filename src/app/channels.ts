// Channels — the org's saved Slack / Teams destinations. MAIN.
//
// A channel is a PATH FOR DATA TO LEAVE THE SERVER, so it belongs to the org
// and only an org admin makes, changes or removes one (src/api/subscriptions.ts);
// members see `{id, name, kind, secretSet}` to pick from.
//
// The record (userData/channels/<id>.json — a `records` row with DATABASE_URL)
// holds the name and the kind. The WEBHOOK URL is a credential — whoever has it
// can post to that channel — so it is never in the record: it is sealed in the
// secrets store (src/server/secrets/store.ts, kind `channel.webhook`, ref = the
// channel id) and read back only by `webhookOf`, for the one module that posts
// (src/server/subscriptions/deliver.ts). It is never returned, never logged.
// Without the store (no DATABASE_URL or no ORDINATE_MASTER_KEY) saving a
// channel is REFUSED rather than written in the clear.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from './paths';
import { isValidId } from './ids';
import * as recordFs from './recordFs';
import type { SecretStore } from '../server/secrets/store';
import { ctx } from '../server/context';
import { channelGone, channelLimit, channelNeedsHttps, channelNeedsName, channelNeedsUrl, channelsNeedStore } from '../analysis/subscriptionText';

export type ChannelKind = 'slack' | 'teams';

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What a browser gets: never the URL, only whether one is stored. */
export interface PublicChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  secretSet: boolean;
}

export const MAX_CHANNELS = 100;
const SECRET = 'channel.webhook';

let store: SecretStore | null = null;
let httpAllowed = false;

/** Hand this module the secret store once the schema is current (src/server/app.ts), or null to drop it. */
export function useChannelSecrets(s: SecretStore | null): void {
  store = s;
}

/** Can a webhook URL be kept on this server? */
export function canKeepWebhooks(): boolean {
  return store !== null;
}

/** Test hook: a local http:// receiver stands in for Slack / Teams. Never set by the server. */
export function allowHttpForTest(on: boolean): void {
  httpAllowed = on;
}

/** Why `raw` cannot be a webhook URL, or null. https only, no credentials in it. */
export function webhookProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return channelNeedsUrl();
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return channelNeedsHttps();
  }
  const scheme = u.protocol === 'https:' || (httpAllowed && u.protocol === 'http:');
  return scheme && !u.username && !u.password && raw.length <= 2048 ? null : channelNeedsHttps();
}

const dir = (): string => path.join(appPaths.userData(), 'channels');
const file = (id: string): string => path.join(dir(), id + '.json');
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

export async function getChannel(id: string): Promise<Channel | null> {
  if (!isValidId(id)) return null;
  try {
    const d = JSON.parse(await recordFs.readFile(file(id), 'utf8'));
    if (!d || d.id !== id || (d.kind !== 'slack' && d.kind !== 'teams')) return null;
    return { id, name: clean(d.name, 80) || d.kind, kind: d.kind, createdBy: clean(d.createdBy, 320), createdAt: clean(d.createdAt, 40), updatedAt: clean(d.updatedAt, 40) };
  } catch {
    return null; // missing or corrupt: skipped, never fatal
  }
}

/** The org's channels, by name. */
export async function listChannels(): Promise<Channel[]> {
  let names: string[];
  try {
    names = await recordFs.readdir(dir());
  } catch {
    return [];
  }
  const out: Channel[] = [];
  for (const n of names) {
    const c = n.endsWith('.json') ? await getChannel(n.slice(0, -5)) : null;
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function secretSet(id: string): Promise<boolean> {
  try {
    return !!store && (await store.get(ctx().org.id, SECRET, id)) !== null;
  } catch {
    return false; // an unreadable secret is not a usable one
  }
}

export async function publicChannel(c: Channel): Promise<PublicChannel> {
  return { id: c.id, name: c.name, kind: c.kind, secretSet: await secretSet(c.id) };
}

export type SaveResult = { ok: true; channel: Channel } | { ok: false; error: string };

/**
 * Create (no `id`) or change a channel. A new one needs its URL; an existing one
 * keeps the stored URL when `webhookUrl` is blank. The URL is sealed BEFORE the
 * record is written, so a record never names a channel that has no secret.
 */
export async function saveChannel(input: { id?: string; name?: unknown; kind?: unknown; webhookUrl?: unknown }, by: string): Promise<SaveResult> {
  const name = clean(input.name, 80);
  if (!name) return { ok: false, error: channelNeedsName() };
  const cur = input.id ? await getChannel(input.id) : null;
  if (input.id && !cur) return { ok: false, error: channelGone() };
  const url = typeof input.webhookUrl === 'string' ? input.webhookUrl.trim() : '';
  if (!cur || url) {
    const problem = webhookProblem(url);
    if (problem) return { ok: false, error: problem };
  }
  if (!store) return { ok: false, error: channelsNeedStore() };
  if (!cur && (await listChannels()).length >= MAX_CHANNELS) return { ok: false, error: channelLimit(MAX_CHANNELS) };
  const now = new Date().toISOString();
  const channel: Channel = {
    id: cur ? cur.id : randomUUID(),
    name,
    kind: cur ? cur.kind : input.kind === 'teams' ? 'teams' : 'slack',
    createdBy: cur ? cur.createdBy : by,
    createdAt: cur ? cur.createdAt : now,
    updatedAt: now,
  };
  if (url) await store.put(ctx().org.id, SECRET, channel.id, url);
  await fs.promises.mkdir(dir(), { recursive: true });
  const tmp = file(channel.id) + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(channel, null, 2), 'utf8');
  await recordFs.rename(tmp, file(channel.id));
  return { ok: true, channel };
}

/** Remove a channel and its sealed URL. */
export async function deleteChannel(id: string): Promise<boolean> {
  if (!isValidId(id) || !(await getChannel(id))) return false;
  await recordFs.rm(file(id), { force: true });
  if (store) await store.delete(ctx().org.id, SECRET, id);
  return true;
}

/** A channel's webhook URL — for the delivery module ONLY. Null when none is stored or it cannot be read. */
export async function webhookOf(id: string): Promise<string | null> {
  if (!isValidId(id) || !store) return null;
  try {
    return await store.get(ctx().org.id, SECRET, id);
  } catch {
    return null;
  }
}
