// The tool rail down the side of the workbench and the ONE flyout it opens
// (legacy authoringRail.ts): Data, Visuals, Filters, Properties. Clicking the
// lit icon again closes the flyout and the sheet takes the window.

import { useState } from 'react';
import { Link } from 'react-router';
import { useDatasetColumns } from '../../../api/datasets';
import { buttonClass } from '../../../ui/Button';
import { TypeBadge } from '../../../ui/DataGrid/GridParts';
import { Input } from '../../../ui/Field';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import { vizGlyph, vizLabel } from '../VisualTile';
import { builderFor, builderNew, useAddVisualCard } from './AddVisual';
import { useEditor, type Pane } from './context';
import { Properties } from './Properties';
import s from './Editor.module.css';

const PANES: { id: NonNullable<Pane>; label: string; icon: IconName }[] = [
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'visuals', label: 'Visuals', icon: 'chart-bar' },
  { id: 'filters', label: 'Filters', icon: 'filter' },
  { id: 'props', label: 'Properties', icon: 'sliders' },
];

/** The selected visual card's dataset fields, read-only (authoringPanes.ts anRenderBrowseFields). */
function DataPane() {
  const ed = useEditor();
  const card = ed.cards.find((c) => c.id === ed.selected);
  const def = card?.type === 'visual' && card.visualId ? ed.visuals.get(card.visualId) : undefined;
  const cols = useDatasetColumns(ed.projectId, def?.datasetId);
  const [q, setQ] = useState('');
  if (!def) return <p className={s.paneHint}>Select a visual card to see its dataset’s fields.</p>;
  const shown = (cols.data?.columns ?? []).filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className={s.paneBody}>
      {cols.data && (
        <div className={s.dsLine}>
          <Icon name="database" size={12} />
          <span className={s.dsName} title={cols.data.name}>
            {cols.data.name}
          </span>
        </div>
      )}
      <Input size="sm" icon="search" type="search" aria-label="Search fields" placeholder="Search fields" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className={s.fields}>
        {shown.map((c) => (
          <li key={c.name} className={s.field}>
            <TypeBadge type={c.type} />
            <span>{c.name}</span>
          </li>
        ))}
        {cols.data && shown.length === 0 && <li className={s.paneHint}>No field matches “{q.trim()}”.</li>}
      </ul>
      <Link className={buttonClass('secondary', 'sm')} to={builderFor(ed.projectId, def.id)}>
        <Icon name="pencil" />
        <span>Edit fields in the Visuals builder</span>
      </Link>
    </div>
  );
}

/** The project's saved visuals, newest first: click one to put it on the sheet. */
function VisualsPane() {
  const ed = useEditor();
  const add = useAddVisualCard();
  const list = [...ed.visuals.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return (
    <div className={s.paneBody}>
      <Link className={buttonClass('secondary', 'sm')} to={builderNew(ed.projectId)}>
        <Icon name="plus" />
        <span>New visual</span>
      </Link>
      {list.length === 0 ? (
        <p className={s.paneHint}>No saved visuals yet. Make one in the Visuals builder, then add it here.</p>
      ) : (
        <div className={s.gallery}>
          {list.map((v) => (
            <button key={v.id} type="button" className={s.tile} title={`${v.name} · ${vizLabel(v.chartType)} — click to add`} onClick={() => add(v.id, v.name)}>
              <Icon name={vizGlyph(v.chartType)} size={20} />
              <span className={s.tileName}>{v.name || 'Untitled visual'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The dashboard-wide filters (the toolbar authoring.ts moved into this flyout) and the controls. */
function FiltersPane() {
  const ed = useEditor();
  const steps = ed.doc.filters;
  const describe = (st: Record<string, unknown>) =>
    `${String(st.column ?? '')} ${String(st.op ?? '')} ${Array.isArray(st.values) ? st.values.join(', ') : st.value == null ? '' : String(st.value)}`.trim();
  return (
    <div className={s.paneBody}>
      <p className={s.paneHint}>Dashboard filters apply to every card before its own. Controls sit above the sheet, where readers move them.</p>
      {steps.length === 0 ? (
        <p className={s.paneHint}>No dashboard-wide filters.</p>
      ) : (
        <ul className={s.filterList}>
          {steps.map((st, i) => (
            <li key={i} className={s.filterRow}>
              <span>{describe(st)}</span>
              <button
                type="button"
                className={s.filterX}
                aria-label={`Remove filter ${describe(st)}`}
                onClick={() => ed.edit('Remove filter', (d) => void d.filters.splice(i, 1))}
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => ed.openAdd('control')}>
        <Icon name="filter" />
        <span>Add a control</span>
      </button>
      <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => ed.openAdd('param')}>
        <Icon name="sliders" />
        <span>Add a parameter</span>
      </button>
    </div>
  );
}

export function Rail() {
  const ed = useEditor();
  const open = PANES.find((p) => p.id === ed.pane);
  return (
    <>
      <nav className={s.rail} aria-label="Authoring panels">
        {PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            className={ed.pane === p.id ? `${s.railBtn} ${s.railOn}` : s.railBtn}
            aria-expanded={ed.pane === p.id}
            aria-label={p.label}
            title={p.label}
            onClick={() => ed.setPane(ed.pane === p.id ? null : p.id)}
          >
            <Icon name={p.icon} size={20} />
          </button>
        ))}
      </nav>
      {open && (
        <aside className={s.flyout} aria-label={open.label}>
          <div className={s.paneHead}>
            <span className={s.paneTitle}>{open.label}</span>
          </div>
          {open.id === 'data' && <DataPane />}
          {open.id === 'visuals' && <VisualsPane />}
          {open.id === 'filters' && <FiltersPane />}
          {open.id === 'props' && <Properties />}
        </aside>
      )}
    </>
  );
}
