// Which platform a channel is on — a small lettered tile, not a logo: `#` for
// Slack, `T` for Teams, `@` for email. Always beside the platform's name or the
// channel's, so it is never the only thing that says which.

import type { ChannelKind } from './api';
import s from './Preview.module.css';

export const KIND_LABEL: Record<ChannelKind, string> = { slack: 'Slack', teams: 'Teams', email: 'Email' };
const GLYPH: Record<ChannelKind, string> = { slack: '#', teams: 'T', email: '@' };
const TONE: Record<ChannelKind, string> = { slack: s.markSlack, teams: s.markTeams, email: s.markEmail };

export function ChannelMark({ kind }: { kind: ChannelKind }) {
  return (
    <span className={`${s.mark} ${TONE[kind]}`} aria-hidden="true">
      {GLYPH[kind]}
    </span>
  );
}

/** A channel by name with its mark — a chip in a row, a line in a list. */
export function ChannelChip({ kind, name, missing }: { kind: ChannelKind; name: string; missing?: boolean }) {
  return (
    <span className={missing ? `${s.chip} ${s.chipMissing}` : s.chip} title={`${KIND_LABEL[kind]} · ${name}`}>
      <ChannelMark kind={kind} />
      <span className={s.chipName}>{name}</span>
    </span>
  );
}
