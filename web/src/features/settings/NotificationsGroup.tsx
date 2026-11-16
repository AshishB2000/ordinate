// Settings → You → Notifications (docs/notifications/00-design.md §5.12): "Email
// me when someone mentions me" — the signed-in person's own switch, on unless
// they turn it off. A mention still reaches them in the bell and as a notice in their
// open tabs either way, and the row says so. "Email me about data asks and dashboard requests" (src/server/mentions/asks.ts,
// src/server/requests) is off unless they turn it on. Not shown on a server without a user
// directory (no one can be mentioned there); disabled, and saying why, on one
// that sends no email.

import { Switch } from '../../ui/Choice';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useMentionPrefs, useSetMentionPrefs } from '../dashboards/mentionsApi';
import { Group } from './Rows';
import s from './Settings.module.css';

export function NotificationsGroup() {
  const prefs = useMentionPrefs();
  const set = useSetMentionPrefs();
  if (prefs.isSuccess && !prefs.data.available) return null;
  return (
    <Group title="Notifications" desc="How Ordinate reaches you when someone mentions you in a comment, or asks for data or a dashboard.">
      {prefs.isPending ? (
        <SkeletonRows rows={1} label="Loading your notification settings" />
      ) : prefs.isError ? (
        <ErrorState compact heading={4} title="Could not read your notification settings" message={prefs.error.message} onRetry={() => void prefs.refetch()} />
      ) : (
        <>
          <Switch
            className={s.switchRow}
            label="Email me when someone mentions me"
            hint={
              prefs.data.mail
                ? 'Mentions always reach you in the bell and as a notice in your open tabs.'
                : 'This server does not send email; mentions still reach you in the bell and as a notice in your open tabs.'
            }
            checked={prefs.data.mail && prefs.data.emailMe}
            disabled={!prefs.data.mail || set.isPending}
            onCheckedChange={(on) => set.mutate({ emailMe: on }, { onError: (err) => toast(err.message, { kind: 'error' }) })}
          />
          <Switch
            className={s.switchRow}
            label="Email me about data asks and dashboard requests"
            hint={
              prefs.data.mail
                ? 'A viewer’s ask for data or a dashboard you can approve, and the answer to a dashboard you asked for. They always reach you in the bell; email is off unless you turn it on.'
                : 'No email goes out from this server; asks and dashboard requests still reach you in the bell.'
            }
            checked={prefs.data.mail && prefs.data.requestEmail}
            disabled={!prefs.data.mail || set.isPending}
            onCheckedChange={(on) => set.mutate({ requestEmail: on }, { onError: (err) => toast(err.message, { kind: 'error' }) })}
          />
        </>
      )}
    </Group>
  );
}
