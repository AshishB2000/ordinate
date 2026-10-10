// The Subscribe dialog's four steps: What, When, Where, Message. Each edits the
// draft and nothing else; what the server makes of it (the cards it can send,
// the next runs, the message) comes back through the preview beside them.

import { Link } from 'react-router';
import { Checkbox, RadioGroup } from '../../ui/Choice';
import { Combobox } from '../../ui/Combobox';
import { Input, Textarea } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Skeleton } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { Icon } from '../../ui/icons/Icon';
import { ChannelMark, KIND_LABEL } from './ChannelMark';
import type { Cadence, ChannelFrame, Draft, Preview } from './api';
import s from './Subscribe.module.css';

export interface StepProps {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  preview: Preview | undefined;
}

const CARD_KIND: Record<string, string> = { metric: 'KPI', visual: 'Visual' };

// ── What ────────────────────────────────────────────────────────────────────

export function WhatStep({
  draft,
  set,
  preview,
  dashboards,
  locked,
}: StepProps & { dashboards: { id: string; name: string }[] | undefined; locked: boolean }) {
  const cards = preview?.cards;
  const picked = new Set(draft.content.cardIds);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    // Kept in the dashboard's own order, which is the order they are sent in.
    set({ content: { mode: 'cards', cardIds: (cards ?? []).map((c) => c.id).filter((c) => next.has(c)) } });
  };
  return (
    <div className={s.step}>
      {!locked && (
        <Select
          label="Dashboard"
          value={draft.analysisId || null}
          placeholder={dashboards ? 'Choose a dashboard…' : 'Loading dashboards…'}
          options={(dashboards ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dashboard' }))}
          onValueChange={(analysisId) => set({ analysisId, content: { mode: 'all', cardIds: [] }, viewId: null })}
        />
      )}
      <RadioGroup
        label="Send"
        value={draft.content.mode}
        onValueChange={(mode) => set({ content: mode === 'all' ? { mode: 'all', cardIds: [] } : { mode: 'cards', cardIds: draft.content.cardIds } })}
        options={[
          { value: 'all', label: 'The whole dashboard', hint: 'Every KPI and visual, as text. Cards added later are included.' },
          { value: 'cards', label: 'Chosen cards', hint: 'Only the ones you tick.' },
        ]}
      />
      {draft.content.mode === 'cards' && (
        <fieldset className={s.cards}>
          <legend className={s.legend}>Cards{cards ? ` · ${picked.size} of ${cards.length}` : ''}</legend>
          {!draft.analysisId ? (
            <p className={s.hint}>Choose a dashboard first.</p>
          ) : !cards ? (
            <div className={s.cardList} role="status" aria-busy="true" aria-label="Loading the dashboard’s cards">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className={s.skRow} />
              ))}
            </div>
          ) : cards.length === 0 ? (
            <p className={s.hint}>This dashboard has no KPI or visual to send yet.</p>
          ) : (
            <div className={s.cardList}>
              {cards.map((c) => (
                <Checkbox
                  key={c.id}
                  label={c.title || 'Untitled'}
                  hint={`${CARD_KIND[c.type]}${c.chartType ? ` · ${c.chartType.replace(/_/g, ' ')}` : ''} · ${c.sheet}`}
                  checked={picked.has(c.id)}
                  onCheckedChange={(on) => toggle(c.id, on)}
                />
              ))}
            </div>
          )}
        </fieldset>
      )}
      {preview && preview.views.length > 0 ? (
        <Select
          label="Saved view"
          hint="The send carries the view’s filters."
          value={draft.viewId ?? ''}
          options={[{ value: '', label: 'The dashboard as saved' }, ...preview.views.map((v) => ({ value: v.id, label: v.name }))]}
          onValueChange={(v) => set({ viewId: v || null })}
        />
      ) : (
        preview && <p className={s.hint}>This dashboard has no saved views; it is sent as saved, with its controls at their defaults.</p>
      )}
    </div>
  );
}

// ── When ────────────────────────────────────────────────────────────────────

const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];
// Monday first, as a working week reads; the value is the server's (0 = Sunday).
const DAYS: [number, string, string][] = [[1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'], [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [0, 'Sun', 'Sunday']];

/** The zones this browser knows, the draft's own among them. */
export function timeZones(current: string): { value: string; label: string }[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    all = [];
  }
  return [...new Set(['UTC', current, ...all])].map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
}

export function WhenStep({ draft, set, preview }: StepProps) {
  const sch = draft.schedule;
  const setSchedule = (patch: Partial<Draft['schedule']>) => set({ schedule: { ...sch, ...patch } });
  const days = sch.days ?? [1];
  return (
    <div className={s.step}>
      <div>
        <span className={s.legend} id="sub-cadence">
          How often
        </span>
        <div className={s.segments} role="radiogroup" aria-labelledby="sub-cadence">
          {CADENCES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={sch.cadence === c.value}
              className={sch.cadence === c.value ? `${s.segment} ${s.segmentOn}` : s.segment}
              onClick={() => set({ schedule: { cadence: c.value, at: sch.at, ...(c.value === 'weekly' ? { days } : {}), ...(c.value === 'monthly' ? { dayOfMonth: sch.dayOfMonth ?? 1 } : {}) } })}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {sch.cadence === 'weekly' && (
        <div>
          <span className={s.legend} id="sub-days">
            On
          </span>
          <div className={s.chips} role="group" aria-labelledby="sub-days">
            {DAYS.map(([d, short, long]) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  aria-label={long}
                  className={on ? `${s.dayChip} ${s.dayOn}` : s.dayChip}
                  // The last day cannot be switched off: a weekly schedule runs on at least one.
                  onClick={() => (on && days.length === 1 ? undefined : setSchedule({ days: on ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b) }))}
                >
                  {short}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className={s.row}>
        {sch.cadence === 'monthly' && (
          <Input
            label="Day of the month"
            type="number"
            min={1}
            max={31}
            value={sch.dayOfMonth ?? 1}
            hint="A shorter month sends on its last day."
            onChange={(e) => setSchedule({ dayOfMonth: Math.min(31, Math.max(1, Math.trunc(Number(e.target.value)) || 1)) })}
          />
        )}
        {sch.cadence === 'hourly' ? (
          <Input
            label="Minute past the hour"
            type="number"
            min={0}
            max={59}
            value={Number(sch.at.slice(3))}
            onChange={(e) => setSchedule({ at: `00:${String(Math.min(59, Math.max(0, Math.trunc(Number(e.target.value)) || 0))).padStart(2, '0')}` })}
          />
        ) : (
          <Input label="At" type="time" value={sch.at} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && setSchedule({ at: e.target.value })} />
        )}
        <Combobox label="Time zone" value={draft.timezone} options={timeZones(draft.timezone)} onValueChange={(timezone) => set({ timezone })} emptyText="No such time zone" />
      </div>
      <div className={s.next} role="status" aria-label="Next runs">
        <Icon name="calendar" />
        {preview ? (
          <div>
            <div className={s.nextSentence}>{preview.scheduleText}</div>
            <div className={s.nextRuns}>Next: {preview.nextRuns.map((r) => r.text).join(' · ')}</div>
          </div>
        ) : (
          <Skeleton className={s.skLine} />
        )}
      </div>
      <p className={s.hint}>If the server is down at that minute, the message is sent when it comes back if less than six hours late, and recorded as missed otherwise.</p>
    </div>
  );
}

// ── Where ───────────────────────────────────────────────────────────────────

export function WhereStep({
  draft,
  set,
  channels,
  pending,
  error,
  onRetry,
}: Pick<StepProps, 'draft' | 'set'> & { channels: ChannelFrame | undefined; pending: boolean; error: string | null; onRetry: () => void }) {
  if (pending) {
    return (
      <div className={s.cardList} role="status" aria-busy="true" aria-label="Loading channels">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className={s.skRow} />
        ))}
      </div>
    );
  }
  if (error || !channels) return <ErrorState compact heading={3} title="Channels could not be loaded" message={error ?? 'Try again.'} onRetry={onRetry} />;
  if (channels.channels.length === 0) {
    return (
      <EmptyState
        compact
        heading={3}
        icon="send"
        title="No channels yet"
        actions={channels.canManage && channels.canStore ? <Link to="/admin?tab=channels">Add a channel in Admin</Link> : undefined}
      >
        {!channels.canStore
          ? 'This server cannot keep webhook URLs yet: it needs a database and a master key (DATABASE_URL and ORDINATE_MASTER_KEY). Ask whoever runs it.'
          : channels.canManage
            ? 'A channel is a Slack or Teams destination an admin has connected. Add one, then come back: your choices here are kept.'
            : 'A channel is a Slack or Teams destination. Only an organization admin can connect one, because it sends data out of Ordinate. Ask an admin to add the channel you need.'}
      </EmptyState>
    );
  }
  const picked = new Set(draft.channelIds);
  return (
    <div className={s.step}>
      <fieldset className={s.cards}>
        <legend className={s.legend}>Send to · {picked.size} chosen</legend>
        <div className={s.cardList}>
          {channels.channels.map((c) => (
            <span key={c.id} className={s.channelRow}>
              <ChannelMark kind={c.kind} />
              <Checkbox
                label={c.name}
                hint={c.secretSet ? KIND_LABEL[c.kind] : `${KIND_LABEL[c.kind]} · its webhook URL is missing — an admin has to paste it again`}
                checked={picked.has(c.id)}
                disabled={!c.secretSet && !picked.has(c.id)}
                onCheckedChange={(on) => set({ channelIds: on ? [...draft.channelIds, c.id] : draft.channelIds.filter((x) => x !== c.id) })}
              />
            </span>
          ))}
        </div>
      </fieldset>
      <p className={s.hint}>
        {channels.canManage ? (
          <>
            Channels are managed in <Link to="/admin?tab=channels">Admin → Channels</Link>.
          </>
        ) : (
          'Need another channel? An organization admin can add it.'
        )}
      </p>
    </div>
  );
}

// ── Message ─────────────────────────────────────────────────────────────────

export function MessageStep({ draft, set, preview, dashboardName }: StepProps & { dashboardName: string }) {
  const msg = draft.message;
  const cond = draft.conditions;
  return (
    <div className={s.step}>
      <Input label="Subscription name" value={draft.name} maxLength={120} hint="How it is listed under Reports → Subscriptions." onChange={(e) => set({ name: e.target.value })} />
      <Input label="Title" value={msg.title} maxLength={150} placeholder={dashboardName} hint="Leave empty to use the dashboard’s name." onChange={(e) => set({ message: { ...msg, title: e.target.value } })} />
      <Textarea label="Note" rows={3} value={msg.note} maxLength={1000} hint="Optional. Shown under the title, as you type it." onChange={(e) => set({ message: { ...msg, note: e.target.value } })} />
      <Checkbox
        label="Include a link to the dashboard"
        hint={preview?.linkNote ?? 'A button that opens this dashboard in Ordinate.'}
        checked={msg.includeLink}
        onCheckedChange={(includeLink) => set({ message: { ...msg, includeLink } })}
      />
      <fieldset className={s.cards}>
        <legend className={s.legend}>Only send when</legend>
        <div className={s.cardList}>
          <Checkbox
            label="Something changed"
            hint="Skip a send whose figures are exactly those of the last one."
            checked={cond.skipUnchanged}
            onCheckedChange={(skipUnchanged) => set({ conditions: { ...cond, skipUnchanged } })}
          />
          <Checkbox
            label="The data has refreshed"
            hint="Skip a send when no dataset behind it was refreshed since the last one."
            checked={cond.onlyWhenRefreshed}
            onCheckedChange={(onlyWhenRefreshed) => set({ conditions: { ...cond, onlyWhenRefreshed } })}
          />
        </div>
      </fieldset>
    </div>
  );
}
