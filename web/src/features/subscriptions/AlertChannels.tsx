// "Also post to" in the alert dialog: the channels a rule posts its sentence and
// figure to when it fires on the server's schedule. Drawn only when the
// organization has channels — a rule without one behaves exactly as before.

import { Checkbox } from '../../ui/Choice';
import { ChannelMark, KIND_LABEL } from './ChannelMark';
import { useChannels } from './api';
import s from './Subscribe.module.css';

export function AlertChannels({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const q = useChannels();
  const channels = q.data?.channels ?? [];
  if (!channels.length) return null;
  return (
    <fieldset className={s.cards}>
      <legend className={s.legend}>Also post to</legend>
      <div className={s.cardList}>
        {channels.map((c) => (
          <span key={c.id} className={s.channelRow}>
            <ChannelMark kind={c.kind} />
            <Checkbox
              label={c.name}
              hint={c.secretSet ? KIND_LABEL[c.kind] : `${KIND_LABEL[c.kind]} · its webhook URL is missing`}
              checked={value.includes(c.id)}
              disabled={!c.secretSet && !value.includes(c.id)}
              onCheckedChange={(on) => onChange(on ? [...value, c.id] : value.filter((x) => x !== c.id))}
            />
          </span>
        ))}
      </div>
      <p className={s.hint}>When the rule fires after a scheduled refresh, its sentence and figure are posted there with a link to this dashboard.</p>
    </fieldset>
  );
}
