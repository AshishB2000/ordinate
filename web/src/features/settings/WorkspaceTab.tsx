// Organization → Workspace: what every member's figures, dates, accent and
// Assistant answers follow — settingsFormats.ts, settingsCalendar.ts and the
// Appearance → Branding, Instructions / Rules and Notifications panes, ported.
// Each control writes through the server (formats:set / branding:set / …),
// whose answer is what the controls then show: the formatter, the accent and
// these controls cannot disagree.

import { useRef, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as OrdFormat from '../../../../src/app/format.ts';
import { rpc, upload } from '../../api/client';
import { applyBrandTokens } from '../../charts/palette';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { Input, Textarea } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { SkeletonBlock } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useLogo, useOrgConfig, usePrefs, useWrite, type FormatPrefs, type Prefs } from './api';
import { Group, Row, Segmented } from './Rows';
import s from './Settings.module.css';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SWATCHES: Array<[string, string]> = [
  ['#2563eb', 'Blue'], ['#7c3aed', 'Violet'], ['#0d9488', 'Teal'], ['#16a34a', 'Green'],
  ['#ea580c', 'Orange'], ['#e11d48', 'Rose'], ['#db2777', 'Pink'], ['#475569', 'Slate'],
];
const APP_BLUE = '#2563eb';
const STYLES = [
  { value: 'auto', label: 'Auto (follows the app)' },
  { value: 'clean', label: 'Light' },
  { value: 'executive', label: 'Executive' },
  { value: 'dense', label: 'Dense' },
  { value: 'dark', label: 'Dark' },
] as const;
const CALENDARS = [
  { value: 'gregorian', label: 'Gregorian' },
  { value: '445', label: 'Retail 4-4-5' },
  { value: '454', label: 'Retail 4-5-4' },
  { value: '544', label: 'Retail 5-4-4' },
  { value: 'iso', label: 'ISO week-year' },
] as const;

/** What prefs:get / formats:set / branding:set answer: applied at once, then cached. */
function useSavePrefs<C extends 'formats:set' | 'branding:set'>(channel: C) {
  const client = useQueryClient();
  return useWrite<C, { ok: boolean } & Partial<Prefs>>(channel, [], (r) => {
    if (!r.ok || !r.formats || !r.branding) return;
    OrdFormat.setFormatPrefs(r.formats);
    applyBrandTokens(document.documentElement, r.branding.accent || '');
    client.setQueryData(['prefs:get'], { formats: r.formats, branding: r.branding });
  });
}

function Preview({ formats }: { formats: FormatPrefs }) {
  // The formatter is module state: set it to exactly what this render shows
  // (the same value the shell applies from prefs:get) before formatting.
  OrdFormat.setFormatPrefs(formats);
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Fixed sample figures, formatted — nothing is computed from data here.
  const cells: Array<[string, string]> = [
    ['Number', OrdFormat.formatNumber(1234567.891, { maxDecimals: 2 })],
    ['Figure', OrdFormat.formatCompact(5194598.73)],
    ['Money', OrdFormat.formatCurrency(5194598.73, { compact: true })],
    ['Percent', OrdFormat.formatPercent(0.1321, 1)],
    ['Date', OrdFormat.formatDate(iso)],
  ];
  return (
    <div className={s.preview} role="group" aria-label="How figures look">
      {cells.map(([k, v]) => (
        <div key={k} className={s.cell}>
          <span className={s.cellK}>{k}</span>
          <span className={s.cellV} data-testid={`fmt-${k.toLowerCase()}`}>
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

interface Today {
  ok: boolean;
  today?: string;
  from?: string;
  to?: string;
  label?: string;
  weeks?: number | null;
}

/** settingsCalendar.ts's preview line: the server's answer under the saved calendar (`calendar:today`), never computed here. */
function CalendarPreview({ f }: { f: FormatPrefs }) {
  const q = useQuery({
    // The calendar fields in the key: a change re-asks the server.
    queryKey: ['calendar:today', f.calendarType, f.yearEnd, f.fiscalYearStart, f.weekStart],
    queryFn: async () => (await rpc('calendar:today')) as Today,
  });
  const r = q.data;
  if (q.isPending) return <div className={s.preview} aria-busy="true" aria-label="Loading the calendar preview" />;
  if (!r?.ok || !r.from || !r.to) return null;
  const cells: Array<[string, string]> = [];
  if (r.label) cells.push(['Today is', r.label]);
  if (r.weeks) cells.push(['This year', `${r.weeks}-week year`]);
  cells.push([f.calendarType === 'iso' ? 'ISO year' : 'Fiscal year', OrdFormat.formatDateRange(r.from, r.to)]);
  return (
    <div className={s.preview} role="group" aria-label="This calendar today" aria-live="polite">
      {cells.map(([k, v]) => (
        <div key={k} className={s.cell}>
          <span className={s.cellK}>{k}</span>
          <span className={s.cellV} data-testid={`cal-${k.toLowerCase().replace(/ /g, '-')}`}>
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

function Formats({ f }: { f: FormatPrefs }) {
  const save = useSavePrefs('formats:set');
  const set = (patch: Parameters<typeof save.mutate>[0]) => save.mutate(patch);
  const weekCal = f.calendarType !== 'gregorian';
  const system = typeof navigator !== 'undefined' && navigator.language ? ` (${navigator.language})` : '';
  return (
    <>
      <Group title="Formats" desc="How every number and date is written — on every chart, card, table and report, for every member.">
        <Preview formats={f} />
        <Row title="Locale" desc="Month names, and the grouping and decimal marks when Numbers follows the locale.">
          <div className={s.select}>
            <Select
              aria-label="Locale"
              value={f.locale}
              onValueChange={(v) => set({ locale: v })}
              options={[{ value: '', label: `System default${system}` }, ...OrdFormat.LOCALES.map((l) => ({ value: l.id, label: l.label }))]}
            />
          </div>
        </Row>
        <Row title="Numbers" desc="Grouping and decimal marks.">
          <div className={s.select}>
            <Select
              aria-label="Numbers"
              value={f.numberStyle}
              onValueChange={(v) => set({ numberStyle: v as FormatPrefs['numberStyle'] })}
              options={OrdFormat.NUMBER_STYLES.map((n) => ({ value: n.id, label: n.label }))}
            />
          </div>
        </Row>
        <Row title="Currency" desc="For money figures that carry no symbol of their own.">
          <div className={s.selectSm}>
            <Select
              aria-label="Currency"
              value={f.currency}
              onValueChange={(v) => set({ currency: v })}
              options={OrdFormat.CURRENCIES.map((c) => ({ value: c, label: `${c} — ${OrdFormat.currencySymbol(c)}` }))}
            />
          </div>
          <Segmented
            label="Currency symbol position"
            value={f.currencyPosition}
            onChange={(v) => set({ currencyPosition: v })}
            options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]}
          />
        </Row>
        <Row title="Dates">
          <Segmented
            label="Date style"
            value={f.dateFormat}
            onChange={(v) => set({ dateFormat: v })}
            options={[{ value: 'short', label: 'Short' }, { value: 'medium', label: 'Medium' }, { value: 'iso', label: 'ISO' }]}
          />
        </Row>
        <Switch
          className={s.switchRow}
          label="Compact numbers"
          hint="Big figures as 5.2M rather than 5,194,598.73, where a view has no format of its own."
          checked={f.compact}
          onCheckedChange={(on) => set({ compact: on })}
        />
      </Group>
      <Group title="Calendar" desc="How weeks, periods, quarters and years are counted in relative filters, comparisons and date grains.">
        <CalendarPreview f={f} />
        <Row title="Calendar" desc="Retail calendars run Sunday–Saturday weeks in 4-4-5, 4-5-4 or 5-4-4 periods.">
          <div className={s.select}>
            <Select aria-label="Calendar" value={f.calendarType} onValueChange={(v) => set({ calendarType: v as FormatPrefs['calendarType'] })} options={CALENDARS} />
          </div>
        </Row>
        {weekCal && f.calendarType !== 'iso' && (
          <Row title="Year ends on" desc="A 53rd week joins the last period when the year needs one.">
            <Segmented
              label="Year ends on"
              value={f.yearEnd}
              onChange={(v) => set({ yearEnd: v })}
              options={[{ value: 'nearest', label: 'Saturday nearest Jan 31' }, { value: 'last', label: 'Last Saturday of January' }]}
            />
          </Row>
        )}
        {!weekCal && (
          <>
            <Row title="Week starts on" desc="For “this week”, “last week” and weekly grains.">
              <div className={s.selectSm}>
                <Select aria-label="Week starts on" value={String(f.weekStart)} onValueChange={(v) => set({ weekStart: Number(v) })} options={DAYS.map((d, i) => ({ value: String(i), label: d }))} />
              </div>
            </Row>
            <Row title="Fiscal year starts in" desc="Quarters and years in relative filters and comparisons.">
              <div className={s.selectSm}>
                <Select aria-label="Fiscal year starts in" value={String(f.fiscalYearStart)} onValueChange={(v) => set({ fiscalYearStart: Number(v) })} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
              </div>
            </Row>
          </>
        )}
      </Group>
    </>
  );
}

function Logo() {
  const logo = useLogo();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const after = (r: { ok: boolean }) => r.ok && void logo.refetch();
  const setLogo = useWrite('branding:setLogo', [['prefs:get']], after);
  const clear = useWrite('branding:clearLogo', [['prefs:get']], after);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const up = await upload(file, file.name);
      await setLogo.mutateAsync({ fileToken: up.fileToken });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That logo could not be uploaded.', { kind: 'error' });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Row title="Logo" desc="PNG or SVG, up to 512 KB. On reports, presented dashboards and exports.">
      <span className={s.logoFrame} aria-busy={logo.isPending}>
        {logo.data ? (
          <img src={logo.data} alt="Workspace logo" />
        ) : (
          <>
            <Icon name="layout-dashboard" />
            {logo.isPending ? 'Loading…' : 'No logo'}
          </>
        )}
      </span>
      <input ref={input} type="file" accept=".png,.svg,image/png,image/svg+xml" hidden onChange={(e) => void pick(e.target.files?.[0])} aria-label="Logo file" />
      <Button size="sm" icon="upload" loading={busy} onClick={() => input.current?.click()}>
        Choose file
      </Button>
      {logo.data && (
        <Button size="sm" variant="ghost" onClick={() => clear.mutate('workspace')}>
          Remove
        </Button>
      )}
    </Row>
  );
}

function Branding({ accent, style }: { accent: string; style: Prefs['branding']['dashboardStyle'] }) {
  const save = useSavePrefs('branding:set');
  const current = accent || APP_BLUE;
  const [hex, setHex] = useState(current);
  const [bad, setBad] = useState(false);
  const commit = () => {
    const v = hex.trim();
    const h = /^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith('#') ? v : '#' + v).toLowerCase() : null;
    setBad(!h);
    // The app's own blue IS no accent: picking it clears the setting.
    if (h && h !== current) save.mutate({ accent: h === APP_BLUE ? '' : h });
  };
  return (
    <Group title="Branding" desc="Your colour and your mark on every member's screens, reports and exports.">
      <Row title="Accent colour" desc="Buttons, selections and the chart palette. Contrast is kept in both themes.">
        <div className={s.swatches} role="radiogroup" aria-label="Accent colour">
          {SWATCHES.map(([h, name]) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={h === current}
              aria-label={name}
              title={name}
              className={s.swatch}
              style={{ '--sw': h } as CSSProperties}
              onClick={() => {
                setHex(h);
                setBad(false);
                save.mutate({ accent: h === APP_BLUE ? '' : h });
              }}
            />
          ))}
        </div>
        <div className={s.hex}>
          <Input
            aria-label="Accent colour as hex"
            value={hex}
            spellCheck={false}
            onChange={(e) => setHex(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            error={bad ? 'A colour like #2563eb.' : undefined}
          />
        </div>
      </Row>
      <Logo />
      <Row title="New dashboards start as" desc="A dashboard's own Style panel still overrides it.">
        <div className={s.select}>
          <Select aria-label="New dashboards start as" value={style} onValueChange={(v) => save.mutate({ dashboardStyle: v as typeof style })} options={STYLES} />
        </div>
      </Row>
    </Group>
  );
}

function Assistant({ rules, autoRefresh, alerts, explain }: { rules: string; autoRefresh: boolean; alerts: boolean; explain: boolean }) {
  const [text, setText] = useState(rules);
  const keys = [['key:status']] as const;
  const saveRules = useWrite('rules:set', keys, (r) => r.ok && toast('Rules saved.', { kind: 'success' }));
  const refresh = useWrite('autorefresh:set', keys);
  const notify = useWrite('notifications:set', keys);
  return (
    <>
      <Group title="Assistant rules" desc="Fixed instructions added to every analysis the Assistant writes for this organization. The required output format wins if they conflict.">
        <div className={s.rules}>
          <Textarea
            aria-label="Assistant rules"
            rows={4}
            maxLength={20_000}
            placeholder="e.g. Focus on the bottom line. Flag any risks. Keep it under three sentences."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className={s.actionsRow}>
          <Button size="sm" disabled={text === rules} onClick={() => setText(rules)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" icon="check" disabled={text === rules} loading={saveRules.isPending} onClick={() => saveRules.mutate({ text })}>
            Save rules
          </Button>
        </div>
      </Group>
      <Group title="Refresh and alerts" desc="Run on the server for the whole organization, whether or not anyone has Ordinate open.">
        <Switch className={s.switchRow} label="Auto-refresh datasets" hint="Datasets with a refresh schedule are re-fetched on it. Off pauses every schedule." checked={autoRefresh} onCheckedChange={(on) => refresh.mutate(on)} />
        <Switch className={s.switchRow} label="Alert notifications" hint="When an alert rule fires, tell the members who are signed in." checked={alerts} onCheckedChange={(on) => notify.mutate({ fields: { alerts: on } })} />
        <Switch className={s.switchRow} label="Explain alerts" hint="After an alert fires, start a conversation about it. Needs a connected model; the alert never waits for it." checked={explain} onCheckedChange={(on) => notify.mutate({ fields: { alertExplain: on } })} />
      </Group>
    </>
  );
}

export function WorkspaceTab() {
  const prefs = usePrefs();
  const org = useOrgConfig();
  if (prefs.isPending || org.isPending) return <SkeletonBlock label="Loading workspace settings" />;
  if (prefs.isError || org.isError) {
    const err = prefs.error ?? org.error;
    return <ErrorState heading={3} title="Workspace settings could not be loaded" message={err?.message ?? ''} onRetry={() => {
          void prefs.refetch();
          void org.refetch();
        }} />;
  }
  const p = prefs.data;
  const o = org.data;
  return (
    <div className={s.stackPage}>
      <Formats f={p.formats} />
      <Branding key={p.branding.accent} accent={p.branding.accent} style={p.branding.dashboardStyle} />
      <Assistant
        key={o.globalRules}
        rules={o.globalRules}
        autoRefresh={o.autoRefresh}
        alerts={o.notifications.alerts !== false}
        explain={!!o.notifications.alertExplain}
      />
    </div>
  );
}
