// An agent's Slack channels (docs/slack/00-design.md): a project admin ties the channels the bot is in to this agent. A
// channel answers with ONE agent; one another agent holds is moved here when chosen. An unmapped channel gets "not
// connected yet" from Ordinate, never a guess at a project. Saved on its own button, apart from the agent's settings.

import { useEffect, useState } from 'react';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { SkeletonRows } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { useAgentChannels, useSetAgentChannels, useSlackChannels } from '../../admin/slack/api';
import s from '../../admin/slack/Slack.module.css';

export function SlackChannels({ projectId, agentId }: { projectId: string; agentId: string }) {
  const picker = useSlackChannels(projectId);
  const mine = useAgentChannels(projectId, agentId);
  const save = useSetAgentChannels(projectId, agentId);
  const held = mine.data && mine.data.ok ? mine.data.channels.map((c) => c.channelId).join() : '';
  const [picked, setPicked] = useState<string[] | null>(null);
  useEffect(() => setPicked(null), [held]);

  if (picker.isPending || mine.isPending) return <SkeletonRows rows={2} label="Loading Slack channels" />;
  if (picker.isError || mine.isError) {
    const err = (picker.error ?? mine.error) as Error;
    return <ErrorState compact heading={4} title="Could not read the Slack channels" message={err.message} onRetry={() => void Promise.all([picker.refetch(), mine.refetch()])} />;
  }
  if (!picker.data.ok || !mine.data.ok) return <p className={s.note}>{!picker.data.ok ? picker.data.error : !mine.data.ok ? mine.data.error : ''}</p>;
  if (!picker.data.connected) return <p className={s.note}>Slack is not set up yet. An organization admin connects it in Admin → Slack, then you can choose channels here.</p>;
  const channels = picker.data.channels;
  if (!channels.length) return <p className={s.note}>The bot is in no channel yet. Invite @Ordinate to one in Slack (type /invite @Ordinate there), then it appears here.</p>;

  const current = picked ?? mine.data.channels.map((c) => c.channelId);
  const toggle = (id: string, on: boolean) => setPicked(on ? [...current, id] : current.filter((x) => x !== id));
  const dirty = picked !== null && [...picked].sort().join() !== mine.data.channels.map((c) => c.channelId).sort().join();
  return (
    <div className={s.stack}>
      <div className={s.pickList} role="group" aria-label="Slack channels">
        {channels.map((c) => {
          const elsewhere = !!c.agentId && c.agentId !== agentId;
          return (
            <div key={c.id} className={s.pickRow}>
              <Checkbox label={`#${c.name}`} checked={current.includes(c.id)} onCheckedChange={(on) => toggle(c.id, on === true)} />
              <span className={s.pickName} />
              {c.isPrivate && <Badge tone="neutral" icon="lock">Private</Badge>}
              {elsewhere && <span className={s.pickMeta}>Held by another agent: choosing it moves it here.</span>}
            </div>
          );
        })}
      </div>
      <div className={s.actions}>
        <Button
          size="sm"
          icon="check"
          loading={save.isPending}
          disabled={!dirty}
          onClick={() => save.mutate(picked ?? [], { onSuccess: (r) => (r.ok ? toast('Slack channels saved.', { kind: 'success' }) : toast(r.error, { kind: 'error' })), onError: (e) => toast(e.message, { kind: 'error' }) })}
        >
          Save channels
        </Button>
        <span className={s.pickMeta}>@Ordinate in a chosen channel is answered by this agent, in a thread.</span>
      </div>
    </div>
  );
}
