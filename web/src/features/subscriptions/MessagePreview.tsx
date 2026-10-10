// The message as it will arrive — drawn from the server's model for each
// platform (src/analysis/subscriptionRender.ts cuts it to fit; this draws what
// it kept). Nothing here computes or formats a figure: every value, change and
// sentence is the server's string, placed the way Slack and Teams place it.

import { useState } from 'react';
import { Skeleton } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { Icon } from '../../ui/icons/Icon';
import { ChannelMark } from './ChannelMark';
import type { ChannelKind, MessageModel, MessageSection, PlatformPreview, Preview } from './api';
import s from './Preview.module.css';

function SlackSection({ sec }: { sec: MessageSection }) {
  const cols = sec.columns.filter(Boolean);
  return (
    <div className={s.slackBlock}>
      <strong>{sec.title}</strong>
      {sec.caption && <div>{sec.caption}</div>}
      {sec.note && <em className={s.dim}>{sec.note}</em>}
      {cols.length > 0 && sec.rows.length > 0 && <em className={s.dim}>{cols.join(' · ')}</em>}
      {sec.rows.length > 0 && (
        <ul className={s.slackRows}>
          {sec.rows.map((r, i) => (
            <li key={i}>
              {r[0]}
              {r.length > 1 && <span className={s.slackValue}> — {r.slice(1).join(' · ')}</span>}
            </li>
          ))}
        </ul>
      )}
      {sec.more > 0 && <em className={s.dim}>+{sec.more} more in the dashboard</em>}
    </div>
  );
}

function SlackMessage({ m }: { m: MessageModel }) {
  return (
    <div className={s.slack} data-testid="preview-slack">
      <span className={s.avatar} aria-hidden="true">
        <img src="/favicon.svg" alt="" />
      </span>
      <div className={s.slackBody}>
        <div className={s.slackHead}>
          <span className={s.sender}>Ordinate</span>
          <span className={s.appTag}>APP</span>
        </div>
        <div className={s.slackTitle}>{m.title}</div>
        {m.subtitle.length > 0 && <div className={s.slackContext}>{m.subtitle.join('  ·  ')}</div>}
        {m.note && <div className={s.slackBlock}>{m.note}</div>}
        {m.kpis.length > 0 && (
          <div className={s.slackFields}>
            {m.kpis.map((k, i) => (
              <div key={i} className={s.slackField}>
                <strong>{k.label}</strong>
                <span>{k.value}</span>
                {k.change && <span className={s.dim}>{k.change}</span>}
              </div>
            ))}
          </div>
        )}
        {m.sections.map((sec, i) => (
          <SlackSection key={i} sec={sec} />
        ))}
        {m.more > 0 && <div className={s.slackContext}>+{m.more} more in the dashboard</div>}
        {m.link && <span className={s.slackButton}>{m.link.label}</span>}
        {m.footer && <div className={s.slackContext}>{m.footer}</div>}
      </div>
    </div>
  );
}

function TeamsMessage({ m }: { m: MessageModel }) {
  return (
    <div className={s.teams} data-testid="preview-teams">
      <div className={s.teamsTitle}>{m.title}</div>
      {m.subtitle.length > 0 && <div className={s.teamsSubtle}>{m.subtitle.join('  ·  ')}</div>}
      {m.note && <div className={s.teamsText}>{m.note}</div>}
      {m.kpis.length > 0 && (
        <div className={s.teamsKpis}>
          {m.kpis.map((k, i) => (
            <div key={i} className={s.teamsKpi}>
              <span className={s.teamsSubtle}>{k.label}</span>
              <span className={s.teamsFigure}>{k.value}</span>
              {k.change && <span className={k.tone === 'good' ? s.good : k.tone === 'bad' ? s.bad : s.teamsSubtle}>{k.change}</span>}
            </div>
          ))}
        </div>
      )}
      {m.sections.map((sec, i) => (
        <div key={i} className={s.teamsSection}>
          <div className={s.teamsHeading}>{sec.title}</div>
          {sec.caption && <div className={s.teamsSubtle}>{sec.caption}</div>}
          {sec.note && <em className={s.teamsSubtle}>{sec.note}</em>}
          {sec.rows.length > 0 && sec.columns.some(Boolean) && (
            <div className={`${s.teamsRow} ${s.teamsSubtle}`}>
              <span>{sec.columns[0]}</span>
              <span>{sec.columns.slice(1).join('  ·  ')}</span>
            </div>
          )}
          {sec.rows.map((r, j) => (
            <div key={j} className={s.teamsRow}>
              <span>{r[0]}</span>
              <strong>{r.slice(1).join('  ·  ')}</strong>
            </div>
          ))}
          {sec.more > 0 && <em className={s.teamsSubtle}>+{sec.more} more in the dashboard</em>}
        </div>
      ))}
      {m.more > 0 && <em className={s.teamsSubtle}>+{m.more} more in the dashboard</em>}
      {m.footer && <div className={`${s.teamsSubtle} ${s.teamsFooter}`}>{m.footer}</div>}
      {m.link && <span className={s.teamsButton}>{m.link.label}</span>}
    </div>
  );
}

const PLATFORMS: { kind: ChannelKind; label: string }[] = [
  { kind: 'slack', label: 'Slack' },
  { kind: 'teams', label: 'Teams' },
];

/**
 * The persistent preview beside the dialog's steps: a tab per platform, the
 * message, then what the platform's limit did to it. `prefer`: the platform to
 * open on (the kind of the first chosen channel).
 */
export function MessagePreview({
  preview,
  pending,
  error,
  onRetry,
  prefer,
}: {
  preview: Preview | undefined;
  pending: boolean;
  error: string | null;
  onRetry: () => void;
  prefer?: ChannelKind;
}) {
  const [picked, setPicked] = useState<ChannelKind | null>(null);
  const kind = picked ?? prefer ?? 'slack';
  const p: PlatformPreview | null | undefined = preview ? preview[kind] : undefined;
  return (
    <section className={s.pane} aria-label="Preview">
      <div className={s.paneHead}>
        <span className={s.paneTitle}>Preview</span>
        <div className={s.switch} role="tablist" aria-label="Preview as">
          {PLATFORMS.map((x) => (
            <button key={x.kind} type="button" role="tab" aria-selected={kind === x.kind} className={kind === x.kind ? `${s.switchBtn} ${s.switchOn}` : s.switchBtn} onClick={() => setPicked(x.kind)}>
              <ChannelMark kind={x.kind} />
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <div className={kind === 'slack' ? `${s.stage} ${s.stageSlack}` : `${s.stage} ${s.stageTeams}`} aria-busy={pending && !preview ? true : undefined}>
        {error && !preview ? (
          <ErrorState compact heading={3} title="The preview could not be built" message={error} onRetry={onRetry} />
        ) : !preview ? (
          <div className={s.skeleton} role="status" aria-label="Building the preview">
            <Skeleton className={s.skTitle} />
            <Skeleton className={s.skLine} />
            <Skeleton className={s.skBlock} />
            <Skeleton className={s.skBlock} />
          </div>
        ) : preview.empty || !p ? (
          <div className={s.nothing} role="status">
            <Icon name="info" />
            <span>{preview.empty ?? 'There is nothing to send yet.'}</span>
          </div>
        ) : kind === 'slack' ? (
          <SlackMessage m={p.model} />
        ) : (
          <TeamsMessage m={p.model} />
        )}
      </div>
      {preview && p && (
        <div className={s.paneFoot}>
          <span className={s.size}>
            {kind === 'slack' && p.blocks !== undefined ? `${p.blocks} of 50 blocks · ` : ''}
            {p.size}
            {kind === 'teams' ? ' of 28 KB' : ''}
          </span>
          {p.notes.map((n) => (
            <span key={n} className={s.note}>
              <Icon name="alert" size={12} />
              {n}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
