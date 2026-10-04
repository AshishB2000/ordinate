// The chart-type picker (renderResult.buildVizPicker): a chip per recommended
// type, chips the user pulled in, and "+ More" — every chart in three tiers
// (Recommended / Selected / Other charts). A type that cannot draw this data
// is still offered, dimmed, and says what it needs.

import { useState } from 'react';
import { Popover } from '../../ui/Popover';
import { chartCanRender, needsText } from './eligibility';
import type { ChartDataShape } from '../../charts/types';
import type { MapGeo } from '../../charts/maps/types';
import { typeLabel } from './model';
import { VizIcon } from './VizIcon';
import s from './Builder.module.css';

type Data = ChartDataShape & { geo?: MapGeo | null };

export function ChartPicker({
  recommended,
  pool,
  data,
  selected,
  extras,
  onSelect,
  onExtras,
}: {
  recommended: readonly string[];
  pool: readonly string[];
  data: Data;
  selected: string;
  /** Types pulled in from "Other charts" — chips of their own. */
  extras: readonly string[];
  onSelect: (type: string) => void;
  onExtras: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasGeo = !!data.geo;
  const fits = (t: string) => chartCanRender(t, data, hasGeo);
  const suited = new Set(recommended);
  // A restored exploratory type (a saved gauge over categorical data) reads as a chip too.
  const chosen = [...new Set([...extras, selected])].filter((t) => !suited.has(t) && fits(t));
  const chips = [...recommended, ...chosen];

  const pick = (t: string) => {
    setOpen(false);
    if (fits(t) && !suited.has(t) && !extras.includes(t)) onExtras([...extras, t]);
    onSelect(t);
  };
  const drop = (t: string) => {
    onExtras(extras.filter((x) => x !== t));
    if (selected === t) onSelect(recommended[0] ?? t);
  };
  const tiers = [
    { label: 'Recommended', types: [...recommended], tier: '' },
    { label: 'Selected', types: pool.filter((t) => chosen.includes(t)), tier: s.isSelected },
    { label: 'Other charts', types: pool.filter((t) => !suited.has(t) && !chosen.includes(t)), tier: s.isOther },
  ].filter((g) => g.types.length);

  return (
    <div className={s.switcher} role="radiogroup" aria-label="Chart type">
      {chips.map((t) => (
        <button key={t} type="button" role="radio" aria-checked={t === selected} className={t === selected ? `${s.chipBtn} ${s.active}` : s.chipBtn} onClick={() => onSelect(t)} data-type={t}>
          <VizIcon type={t} size={13} />
          {typeLabel(t)}
        </button>
      ))}
      <Popover
        title="All chart types"
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button type="button" className={s.more} aria-label="More chart types">
            + More
          </button>
        }
      >
        <div className={s.morePanel}>
          {tiers.map((g) => (
            <div key={g.label}>
              <div className={s.moreLabel}>{g.label}</div>
              <div className={s.moreGrid}>
                {g.types.map((t) => {
                  const ok = fits(t);
                  return (
                    <span key={t} className={[s.moreItem, g.tier, !ok && s.unfit].filter(Boolean).join(' ')}>
                      <button type="button" className={s.moreBtn} title={ok ? undefined : `Needs ${needsText(t, data, hasGeo)}`} onClick={() => pick(t)} data-type={t}>
                        <VizIcon type={t} size={13} />
                        {typeLabel(t)}
                      </button>
                      {g.tier === s.isSelected && (
                        <button type="button" className={s.moreRemove} aria-label={`Remove ${typeLabel(t)}`} onClick={() => drop(t)}>
                          ×
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Popover>
    </div>
  );
}
