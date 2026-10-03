// Step 1 — every source this server offers, grouped and searchable (legacy
// connNew.ts picker). Built from `connectors:catalog`: nothing here is
// per-connector. Arrow keys / Home / End move across the whole filtered tile
// set, so the grid reads as one list however the groups fall.

import { useRef, type KeyboardEvent } from 'react';
import { Input } from '../../ui/Field';
import { EmptyState } from '../../ui/States';
import type { Connector, Logo } from './api';
import { ConnLogo } from './ConnLogo';
import s from './Connections.module.css';

const matches = (d: Connector, q: string) => !q || d.label.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);

/** Categories in the order the server sorted them (src/connectors/index.ts CATEGORY_ORDER). */
function groupsOf(list: readonly Connector[]): [string, Connector[]][] {
  const by = new Map<string, Connector[]>();
  for (const d of list) by.set(d.category, [...(by.get(d.category) ?? []), d]);
  return [...by];
}

export function ConnectorPicker({
  catalog,
  logos,
  search,
  onSearch,
  onPick,
}: {
  catalog: readonly Connector[];
  logos: Record<string, Logo>;
  search: string;
  onSearch: (q: string) => void;
  onPick: (d: Connector) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const q = search.trim().toLowerCase();
  const shown = catalog.filter((d) => matches(d, q));
  const count = q ? `${shown.length} of ${catalog.length} sources` : `${catalog.length} sources`;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key) || !host.current) return;
    const tiles = [...host.current.querySelectorAll<HTMLButtonElement>('button[data-connector]')];
    const here = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (here < 0) return;
    e.preventDefault();
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? tiles.length - 1
      : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(here + 1, tiles.length - 1)
      : Math.max(here - 1, 0);
    tiles[next].focus();
  }

  if (catalog.length === 0) {
    return (
      <EmptyState icon="plug" title="No data sources are available" heading={3}>
        This server offers no connectors. An administrator can check the server log for drivers that failed to load.
      </EmptyState>
    );
  }
  return (
    <section className={s.picker} aria-labelledby="conn-picker-h">
      <h2 id="conn-picker-h" className={s.sectionH}>
        Add a connection
      </h2>
      <div className={s.searchRow}>
        <Input
          icon="search"
          aria-label="Search data sources"
          placeholder="Search data sources…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <span className={s.count} aria-live="polite">
          {count}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className={s.muted}>No data sources match that search.</p>
      ) : (
        <div className={s.groups} ref={host} onKeyDown={onKeyDown}>
          {groupsOf(shown).map(([cat, items]) => (
            <div key={cat} className={s.group}>
              <h3 className={s.groupH}>
                {cat} ({items.length})
              </h3>
              <div className={s.grid}>
                {items.map((d) => (
                  <button key={d.id} type="button" className={s.tile} data-connector={d.id} onClick={() => onPick(d)}>
                    <ConnLogo logo={logos[d.id]} label={d.label} />
                    <span className={s.tileCopy}>
                      <span className={s.tileLabel}>{d.label}</span>
                      {d.blurb && <span className={s.tileBlurb}>{d.blurb}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
