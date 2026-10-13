// The BRIEF: the two things settled before the Assistant drafts a dashboard —
// what kind it is, and which look it gets. No model is asked to draw this; it
// is on screen at once, as DraftFlow's first step and inside the wizard's.
//
// The KIND goes to `analysis:draft`, where the server turns it into its own
// sentence for the model (src/analysis/planClarify.ts). The LOOK goes to
// `analysis:buildPlan` and nowhere else: a preset id the server applies, never
// something the model is shown. "Workspace default" is no look at all — the
// server then starts the dashboard as Settings says new ones start.

import { PRESETS, styleClass, type DashStyle } from '../dashboards/DashboardChrome';
import { usePrefs } from '../settings/api';
import type { DraftKind, LookId } from './api';
import { CardRadios } from './CardRadios';
import s from './Draft.module.css';

export interface Brief {
  kind: DraftKind;
  /** A look by preset id, or '' for the workspace's default. */
  look: LookId | '';
}
export const DEFAULT_BRIEF: Brief = { kind: 'explore', look: '' };

type Box = [kind: 'visual' | 'metric' | 'text' | 'control', x: number, y: number, w: number, h: number];

// Each kind as the arrangement it asks the model for, on the review sketch's
// 12-column grid — a picture of the idea, not of the page that will be drafted.
const KINDS: { value: DraftKind; title: string; hint: string; art: Box[] }[] = [
  {
    value: 'explore',
    title: 'Explore',
    hint: 'Filters, more charts and a detail table — a dashboard to dig into.',
    art: [['control', 0, 0, 3, 1], ['control', 3, 0, 3, 1], ['control', 6, 0, 2, 1], ['visual', 0, 1, 4, 5], ['visual', 4, 1, 4, 5], ['visual', 8, 1, 4, 5], ['visual', 0, 6, 12, 4]],
  },
  {
    value: 'overview',
    title: 'Overview',
    hint: 'One main chart and a few big numbers, to take in at a glance.',
    art: [['visual', 0, 0, 8, 6], ['metric', 8, 0, 4, 3], ['metric', 8, 3, 4, 3], ['visual', 0, 6, 12, 4]],
  },
  {
    value: 'report',
    title: 'Report',
    hint: 'Charts with a note beside each, read from top to bottom.',
    art: [['visual', 0, 0, 8, 5], ['text', 8, 0, 4, 5], ['visual', 0, 5, 8, 5], ['text', 8, 5, 4, 5]],
  },
];

function KindArt({ boxes }: { boxes: Box[] }) {
  return (
    <span className={s.kindArt}>
      {boxes.map(([kind, x, y, w, h], i) => (
        <span key={i} className={`${s.tile} ${s[`tile_${kind}`]}`} style={{ gridColumn: `${x + 1} / span ${w}`, gridRow: `${y + 1} / span ${h}` }} />
      ))}
    </span>
  );
}

// The looks a draft can be pinned to, by preset id (src/analysis/dashboards.ts
// DASHBOARD_STYLE_PRESETS). The three themes carry the Style dialog's own
// words. Dense is not a theme there — it is the app's look at compact density,
// which that dialog sets with its own control — so it is named here. `style` is
// only what the swatch is painted with; the server holds what a look IS.
const LOOKS: { id: LookId; title: string; hint: string; style: DashStyle }[] = [
  ...PRESETS.map((p) => ({ id: p.value, title: p.label, hint: p.hint, style: { theme: p.value, chosen: true as const, ...(p.value === 'executive' ? { accent: 'slate' as const } : {}) } })),
  { id: 'dense', title: 'Dense', hint: 'Compact rows', style: { density: 'compact' } },
];

/** A dashboard in miniature — a strip of KPIs over charts — painted under one look's tokens. */
function Swatch({ style }: { style: DashStyle }) {
  return (
    <span className={`${s.swatch} ${styleClass({ ...style })}`}>
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} />
      ))}
    </span>
  );
}

export function DraftBrief({ value, onChange }: { value: Brief; onChange: (next: Brief) => void }) {
  // Already in the cache (the shell reads it on load), so this asks nothing. A
  // reply is data: before it lands, or if it is not what it should be, the
  // default simply goes unnamed.
  const prefs = usePrefs().data as { branding?: { dashboardStyle?: unknown } } | null | undefined;
  const mine = LOOKS.find((l) => l.id === prefs?.branding?.dashboardStyle);
  return (
    <div className={s.body}>
      <CardRadios
        label="Kind"
        hint="What the dashboard is for. The Assistant arranges it to suit."
        value={value.kind}
        onChange={(kind) => onChange({ ...value, kind })}
        options={KINDS.map((k) => ({ value: k.value, title: k.title, hint: k.hint, art: <KindArt boxes={k.art} /> }))}
      />
      <CardRadios<Brief['look']>
        as="lead"
        label="Look"
        hint="How it is styled. You can change it later from the dashboard’s Style."
        value={value.look}
        onChange={(look) => onChange({ ...value, look })}
        options={[
          { value: '', title: 'Workspace default', hint: mine ? `${mine.title}, from Settings` : 'From Settings', art: <Swatch style={mine ? mine.style : {}} /> },
          // Auto is what a workspace that never chose gets — the default card above.
          ...LOOKS.filter((l) => l.id !== 'auto').map((l) => ({ value: l.id, title: l.title, hint: l.hint, art: <Swatch style={l.style} /> })),
        ]}
      />
    </div>
  );
}
