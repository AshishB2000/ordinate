// The DOM over a map rather than in it — legends, the "Couldn't place" note,
// the info/warning notes, the empty-over-basemap state and the control
// cluster (Values ▾, the period select, ⋯). Port of mapOverlays.ts and the
// shared bits of mapHexbin.ts. Display only: every figure arrives formatted
// from draw.ts.

import { IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { VALUE_MODES, type ValueMode } from './features';
import type { Legend, Overlay } from './draw';
import s from './MapView.module.css';

let gradSeq = 0;

function LegendBox({ legend }: { legend: Legend }) {
  return (
    <div className={s.legend}>
      <div className={s.legendTitle}>{legend.title}</div>
      {legend.kind === 'ramp' && <Ramp stops={legend.stops} min={legend.min} max={legend.max} />}
      {legend.kind === 'size' &&
        ([
          [legend.r[0], legend.min],
          [legend.r[1], legend.max],
        ] as const).map(([r, label]) => (
          <div key={r} className={s.legendRow}>
            <svg width={r * 2 + 2} height={r * 2 + 2} viewBox={`0 0 ${r * 2 + 2} ${r * 2 + 2}`} aria-hidden="true">
              <circle cx={r + 1} cy={r + 1} r={r} fill={legend.color} fillOpacity={0.55} stroke={legend.color} strokeWidth={1.5} />
            </svg>
            <span>{label}</span>
          </div>
        ))}
      {legend.kind === 'flow' &&
        legend.rows.map(([w, label]) => (
          <div key={label} className={s.legendRow}>
            <svg width="28" height="12" aria-hidden="true">
              <line x1="2" y1="6" x2="26" y2="6" stroke={legend.color} strokeWidth={w} strokeLinecap="round" strokeOpacity={0.7} />
            </svg>
            <span>{label}</span>
          </div>
        ))}
    </div>
  );
}

function Ramp({ stops, min, max }: { stops: readonly string[]; min: string; max: string }) {
  // A gradient bar as SVG — `style-src 'self'` refuses an inline style attribute.
  const id = `cv-ramp-${++gradSeq}`;
  return (
    <>
      <svg width="96" height="8" viewBox="0 0 96 8" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0%" x2="100%" y1="0%" y2="0%">
            {stops.map((c, i) => (
              <stop key={c} offset={`${(i / (stops.length - 1)) * 100}%`} stopColor={c} />
            ))}
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="96" height="8" rx="4" fill={`url(#${id})`} />
      </svg>
      <div className={s.legendRange}>
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </>
  );
}

export function MapOverlays({
  overlay,
  tilesFailed,
  onValueMode,
  onPeriod,
}: {
  overlay: Overlay;
  tilesFailed: boolean;
  onValueMode?: (m: ValueMode) => void;
  onPeriod?: (idx: number) => void;
}) {
  const copy = () => {
    void navigator.clipboard.writeText(overlay.tsv).then(
      () => toast('Data copied to clipboard', { kind: 'success' }),
      () => toast('The clipboard is not available here', { kind: 'error' }),
    );
  };
  const notes = overlay.notes;
  const warn = [notes?.warn, tilesFailed ? 'Basemap tiles could not load — the data still draws' : ''].filter(Boolean).join(' · ');
  return (
    <>
      {overlay.empty && (
        <div className={s.empty}>
          <Icon name="map-pin" size={20} />
          <span>{overlay.empty}</span>
        </div>
      )}
      {overlay.legend && <LegendBox legend={overlay.legend} />}
      {overlay.colorLegend && (
        <div className={`${s.legend} ${s.legendColors}`}>
          <div className={s.legendTitle}>{overlay.colorLegend.title}</div>
          {overlay.colorLegend.rows.map(([label, color]) => (
            <div key={label} className={s.legendRow}>
              <svg width="10" height="10" aria-hidden="true">
                <circle cx="5" cy="5" r="5" fill={color} />
              </svg>
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
      {(notes?.info || warn) && (
        <div className={s.notes}>
          {notes?.info && <div className={s.note}>{notes.info}</div>}
          {warn && <div className={`${s.note} ${s.noteWarn}`}>{warn}</div>}
        </div>
      )}
      {overlay.unmatched && !notes && (
        <div className={s.unmatched} title={overlay.unmatched}>
          {overlay.unmatched}
        </div>
      )}
      <div className={s.controls}>
        {overlay.valueMode && onValueMode && (
          <Menu
            align="end"
            label="Value labels"
            trigger={
              <button type="button" className={overlay.valueMode === 'off' ? s.pill : `${s.pill} ${s.pillOn}`} aria-label="Value labels">
                Values <Icon name="chevron-down" size={12} />
              </button>
            }
            items={[
              {
                kind: 'radio',
                label: 'Value labels',
                value: overlay.valueMode,
                options: VALUE_MODES.map(([value, label]) => ({ value, label })),
                onChange: (v) => onValueMode(v as ValueMode),
              },
            ]}
          />
        )}
        {overlay.periods && onPeriod && (
          <Select
            size="sm"
            aria-label="Select period"
            className={s.period}
            value={String(overlay.period ?? 0)}
            onValueChange={(v) => onPeriod(Number(v) || 0)}
            options={overlay.periods.map((p, i) => ({ value: String(i), label: p || `Period ${i + 1}` }))}
          />
        )}
        <Menu
          align="end"
          trigger={<IconButton icon="more-horizontal" label="Map options" size="sm" className={s.menuBtn} />}
          items={[{ label: 'Copy data', icon: 'copy', onSelect: copy }]}
        />
      </div>
    </>
  );
}
