// The Slack app template an org admin pastes into "Create app from manifest": this server's address filled in, the
// scopes and events Ordinate needs and no others. Built from ORDINATE_PUBLIC_URL (../publicUrl.ts), never a request's
// Host; without it only Socket Mode is offered (Slack does not need to reach us).
//
// Not requested, on purpose: users:read.email (accounts are linked by two sign-ins, never by email), chat:write.public,
// channels:join, channels:history, files:write.

import { publicOrigin } from '../publicUrl';
import { CALLBACK_ROUTE, EVENTS_ROUTE, INTERACTIONS_ROUTE } from './paths';

export const BOT_SCOPES = ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write', 'channels:read', 'groups:read', 'users:read'] as const;
export const BOT_EVENTS = ['app_mention', 'message.im', 'app_uninstalled', 'tokens_revoked'] as const;

/** This server's public origin, or null when it does not know it. */
export function serverOrigin(): string | null {
  try {
    return publicOrigin(process.env.ORDINATE_PUBLIC_URL, process.env.OIDC_REDIRECT_URL);
  } catch {
    return null;
  }
}

/** The manifest object for `mode`, or null for `events` when the public address is unknown. */
export function manifestFor(mode: 'events' | 'socket'): Record<string, unknown> | null {
  const origin = serverOrigin();
  if (mode === 'events' && !origin) return null;
  return {
    display_information: { name: 'Ordinate', description: 'Ask your data questions from Slack. Answers come from Ordinate, as you.' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'Ordinate', always_online: true },
    },
    oauth_config: {
      ...(origin ? { redirect_urls: [origin + CALLBACK_ROUTE] } : {}),
      scopes: { bot: [...BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { ...(mode === 'events' && origin ? { request_url: origin + EVENTS_ROUTE } : {}), bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true, ...(mode === 'events' && origin ? { request_url: origin + INTERACTIONS_ROUTE } : {}) },
      org_deploy_enabled: false,
      socket_mode_enabled: mode === 'socket',
      token_rotation_enabled: false,
    },
  };
}
