// Step 1 — every source this server offers, grouped and searchable (legacy
// connNew.ts picker). Built from `connectors:catalog`: nothing here is
// per-connector. Arrow keys / Home / End move across the whole filtered tile
// set, so the grid reads as one list however the groups fall.
//
// Tiles carry the name only; the source's notes (blurb) are on its form, where
// they are read. A "start without a database" row and a Popular row lead the
// unfiltered view, and chips narrow the grid to one category.

import { useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Input } from '../../ui/Field';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { EmptyState } from '../../ui/States';
import type { Connector, Logo } from './api';
import { ConnLogo } from './ConnLogo';
import s from './Connections.module.css';

const matches = (d: Connector, q: string) => !q || d.label.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);

/** Shown first, in this order, when the catalog has them. */
const POPULAR: readonly string[] = ['postgres', 'mysql', 'snowflake', 'bigquery', 'sqlserver', 'amazon-redshift'];

/** Ways in that need no connection: they open Import in the current project. */
const NO_DB: readonly { icon: IconName; label: string; hint: string; source: string }[] = [
  { icon: 'upload', label: 'Upload a file', hint: 'CSV, Excel, Parquet', source: 'file' },
  { icon: 'clipboard', label: 'Paste data', hint: 'Cells from a spreadsheet', source: 'paste' },
  { icon: 'camera', label: 'From a screenshot', hint: 'A table in an image', source: 'screenshot' },
];

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
  const [cat, setCat] = useState<string | null>(null);
  const q = search.trim().toLowerCase();
  const shown = catalog.filter((d) => matches(d, q) && (!cat || d.category === cat));
  const lead = !q && !cat;
  const popular = lead ? POPULAR.map((id) => catalog.find((d) => d.id === id)).filter((d): d is Connector => !!d) : [];
  const tile = (d: Connector) => (
    <button key={d.id} type="button" className={s.tile} data-connector={d.id} title={d.blurb} onClick={() => onPick(d)}>
      <ConnLogo logo={logos[d.id]} label={d.label} />
      <span className={s.tileLabel}>{d.label}</span>
    </button>
  );
  const count = q || cat ? `${shown.length} of ${catalog.length} sources` : `${catalog.length} sources`;

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
      <div className={s.chips} role="group" aria-label="Category">
        {[null, ...groupsOf(catalog).map(([c]) => c)].map((c) => (
          <button key={c ?? 'all'} type="button" className={s.chip} aria-pressed={cat === c} onClick={() => setCat(c)}>
            {c ?? 'All'}
          </button>
        ))}
      </div>
      {lead && (
        <div className={s.group}>
          <h3 className={s.groupH}>Start without a database</h3>
          <div className={s.grid}>
            {NO_DB.map((w) => (
              <Link key={w.source} className={s.tile} to={`/data/import?source=${w.source}`}>
                <span className={s.wayIcon}>
                  <Icon name={w.icon} size={20} />
                </span>
                <span className={s.tileCopy}>
                  <span className={s.tileLabel}>{w.label}</span>
                  <span className={s.tileBlurb}>{w.hint}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {shown.length === 0 ? (
        <p className={s.muted}>No data sources match that search.</p>
      ) : (
        <div className={s.groups} ref={host} onKeyDown={onKeyDown}>
          {popular.length > 0 && (
            <div className={s.group}>
              <h3 className={s.groupH}>Popular</h3>
              <div className={s.grid}>{popular.map(tile)}</div>
            </div>
          )}
          {groupsOf(shown).map(([cat, items]) => (
            <div key={cat} className={s.group}>
              <h3 className={s.groupH}>
                {cat} ({items.length})
              </h3>
              <div className={s.grid}>
                {items.map(tile)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
