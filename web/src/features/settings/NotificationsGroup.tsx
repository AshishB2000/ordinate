// Settings → You → Notifications (docs/notifications/00-design.md §5.12): "Email
// me when someone mentions me" — the signed-in person's own switch, on unless
// they turn it off. A mention still reaches them on Home and as a notice in their
// open tabs either way, and the row says so. Not shown on a server without a user
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
    <Group title="Notifications" desc="How Ordinate reaches you when someone mentions you in a comment.">
      {prefs.isPending ? (
        <SkeletonRows rows={1} label="Loading your notification settings" />
      ) : prefs.isError ? (
        <ErrorState compact heading={4} title="Could not read your notification settings" message={prefs.error.message} onRetry={() => void prefs.refetch()} />
      ) : (
        <Switch
          className={s.switchRow}
          label="Email me when someone mentions me"
          hint={
            prefs.data.mail
              ? 'Mentions always reach you on Home and as a notice in your open tabs.'
              : 'This server does not send email; mentions still reach you on Home and as a notice in your open tabs.'
          }
          checked={prefs.data.mail && prefs.data.emailMe}
          disabled={!prefs.data.mail || set.isPending}
          onCheckedChange={(on) => set.mutate(on, { onError: (err) => toast(err.message, { kind: 'error' }) })}
        />
      )}
    </Group>
  );
}
