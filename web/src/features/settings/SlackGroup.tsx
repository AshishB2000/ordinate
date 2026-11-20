// Settings → You → Slack (docs/slack/00-design.md): whether this person's Slack account is linked, and Disconnect. A
// link says who someone is, never what they may see: every Slack question is answered with their Ordinate access as it
// is now. Hidden on a server where an org admin has not set Slack up. The Connect flow ends here: Slack's answer
// redirects to /settings?slack=<result>, and the result is said once, then dropped from the address.

import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useMySlack, useUnlinkSlack } from '../admin/slack/api';
import { Group, Row } from './Rows';

const RESULTS: Record<string, { kind: 'success' | 'error'; text: string }> = {
  linked: { kind: 'success', text: 'Your Slack account is linked. Go back to Slack: your question is being answered.' },
  state: { kind: 'error', text: 'That Connect button has expired or was already used. Ask your question in Slack again for a new one.' },
  mismatch: { kind: 'error', text: 'That Connect button belongs to another Slack account. Ask in Slack with the account you want to link.' },
  denied: { kind: 'error', text: 'Slack did not confirm your account. Nothing was linked.' },
  slack: { kind: 'error', text: 'Slack could not confirm your account. Try the Connect button again.' },
};

export function SlackGroup() {
  const me = useMySlack();
  const unlink = useUnlinkSlack();
  const [params, setParams] = useSearchParams();
  const result = params.get('slack');
  useEffect(() => {
    const r = result ? RESULTS[result] : undefined;
    if (!r) return;
    toast(r.text, { kind: r.kind });
    const next = new URLSearchParams(params);
    next.delete('slack');
    setParams(next, { replace: true });
  }, [result, params, setParams]);

  if (me.isSuccess && (!me.data.ok || !me.data.available)) return null;
  const link = me.isSuccess && me.data.ok ? me.data.links[0] : undefined;
  return (
    <Group title="Slack" desc="Ask Ordinate questions from Slack. Answers use your own access, the same as in the app.">
      {me.isPending ? (
        <SkeletonRows rows={1} label="Loading your Slack link" />
      ) : me.isError ? (
        <ErrorState compact heading={4} title="Could not read your Slack link" message={me.error.message} onRetry={() => void me.refetch()} />
      ) : link ? (
        <Row title="Slack account" desc={`Linked to ${me.data.ok ? (me.data.teamName ?? 'your workspace') : 'your workspace'}. Disconnect and the next question asks you to connect again.`}>
          <Badge tone="ok" icon="circle-check">Connected</Badge>
          <Button size="sm" loading={unlink.isPending} onClick={() => unlink.mutate(undefined, { onSuccess: () => toast('Your Slack account is disconnected.', { kind: 'success' }), onError: (e) => toast(e.message, { kind: 'error' }) })}>
            Disconnect
          </Button>
        </Row>
      ) : (
        <Row title="Slack account" desc="Not connected yet. Ask Ordinate a question in Slack and it sends you a private Connect button.">
          <Badge tone="neutral">Not connected</Badge>
        </Row>
      )}
    </Group>
  );
}
