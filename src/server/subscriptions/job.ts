// Subscriptions on the server's schedule: the `subscriptions` job.
//
// A kind in the same jobs table the refresh tick rides (../jobs/runner.ts), one
// row per org: a pod CLAIMS it with a lease (`FOR UPDATE SKIP LOCKED`), so two
// pods never run one org's due subscriptions at the same time, and a pod that
// dies mid-run is retaken after its lease. Its own kind rather than a hook on
// the `tick` job, so a slow Slack — three attempts with a backoff per channel —
// never holds up dataset refreshes and alerts, and a refresh never delays a send.
//
// Needs Postgres, like every job: without DATABASE_URL nothing is scheduled
// (and no webhook URL can be stored either — src/app/channels.ts).

import type { Pool } from 'pg';
import { useChannelSecrets } from '../../app/channels';
import type { ServerEnv } from '../env';
import type { SecretStore } from '../secrets/store';
import { defineJob } from '../jobs/runner';
import { wireMail, type MailLog } from '../mail/emailChannel';
import { useDeliveryLog } from './deliver';
import { tickSubscriptions, useSubscriptionDb } from './run';

/** How often an org's subscriptions are checked. A slot is sent within this of its minute. */
export const SUBSCRIPTIONS_EVERY_MS = 60_000;

let defined = false;

/** Called once the schema is current (src/server/app.ts): accounts, the sealed webhook URLs, the SMTP relay, the log, the job. */
export function wireSubscriptions(pool: Pool, cfg: Pick<ServerEnv, 'auth' | 'mail'>, secrets: SecretStore | null, log: MailLog): void {
  useSubscriptionDb(pool, cfg.auth.mode === 'dev');
  useChannelSecrets(secrets);
  useDeliveryLog(log);
  wireMail(cfg.mail, pool, cfg.auth.allowedDomains, log);
  if (defined) return; // a second app in one process (tests) shares the kind
  defined = true;
  // Out of budget: due subscriptions may be left (their slots unstamped); the runner runs the row again soon.
  defineJob('subscriptions', {
    everyMs: SUBSCRIPTIONS_EVERY_MS,
    run: async (_target, stopAt) => {
      await tickSubscriptions(Date.now(), stopAt);
      return Date.now() >= stopAt;
    },
  });
}

/** On close: nothing reads a pool or a store that has gone. */
export function unwireSubscriptions(): void {
  useSubscriptionDb(null, true);
  useChannelSecrets(null);
  wireMail(null, null, []);
}
