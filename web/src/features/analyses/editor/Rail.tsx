// The tool rail down the side of the workbench and the ONE flyout it opens
// (legacy authoringRail.ts): Data, Visuals, Filters, Properties. Clicking the
// lit icon again closes the flyout and the sheet takes the window.

import { useState } from 'react';
import { Link } from 'react-router';
import { useDatasetColumns, useDatasets } from '../../../api/datasets';
import { Select } from '../../../ui/Select';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { useColumnDocs } from '../../data/api';
import type { FilterStep } from '../../visuals/api';
import { FilterRows } from '../../visuals/filters/FilterRows';
import { buttonClass } from '../../../ui/Button';
import { TypeBadge } from '../../../ui/DataGrid/GridParts';
import { Input } from '../../../ui/Field';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import type { VisualDef } from '../api';
import { vizGlyph, vizLabel } from '../VisualTile';
import { builderFor, builderNew, useAddVisualCard } from './AddVisual';
import { useEditor, type Pane } from './context';
import { Properties } from './Properties';
import s from './Editor.module.css';
import { QuickFilters } from '../../dashboards/ControlsExtras';

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
  if (!def) {
    return (
      <EmptyState compact heading={3} icon="database" title="No card selected">
        Select a visual card to see its dataset’s fields.
      </EmptyState>
    );
  }
  return <Fields key={def.datasetId} def={def} />;
}

function Fields({ def }: { def: VisualDef }) {
  const ed = useEditor();
  const cols = useDatasetColumns(ed.projectId, def.datasetId);
  // The catalog's display names and descriptions (authoringPanes.ts ctDocColumns).
  const docs = useColumnDocs(ed.projectId, def.datasetId);
  const sets = useDatasets(ed.projectId);
  const [q, setQ] = useState('');
  if (cols.isPending) return <SkeletonRows rows={6} label="Reading the fields" />;
  if (cols.isError || !cols.data) return <ErrorState compact heading={3} title="The fields could not be read" message={cols.error?.message ?? 'This dataset is no longer in the project.'} onRetry={() => void cols.refetch()} />;
  const label = (name: string) => docs.data?.[name]?.displayName || name;
  const needle = q.trim().toLowerCase();
  const shown = cols.data.columns.filter((c) => !needle || c.name.toLowerCase().includes(needle) || label(c.name).toLowerCase().includes(needle));
  const kind = sets.data?.find((d) => d.id === def.datasetId)?.sourceKind;
  return (
    <div className={s.paneBody}>
      <div className={s.dsLine}>
        <Icon name="database" size={12} />
        {kind && <span className={s.dsKind}>{kind.toUpperCase()}</span>}
        <span className={s.dsName} title={cols.data.name}>
          {cols.data.name}
        </span>
      </div>
      <Input size="sm" icon="search" type="search" aria-label="Search fields" placeholder="Search fields" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className={s.fields}>
        {shown.map((c) => (
          <li key={c.name} className={s.field} title={[`${c.name} · ${c.type}`, docs.data?.[c.name]?.description].filter(Boolean).join('\n')}>
            <TypeBadge type={c.type} />
            <span>{label(c.name)}</span>
          </li>
        ))}
        {shown.length === 0 && <li className={s.paneHint}>No field matches “{q.trim()}”.</li>}
      </ul>
      {/* "+ Calculated field" (authoringRail.ts): a calculated_field step on this dataset, in Prepare. */}
      <Link className={buttonClass('ghost', 'sm')} to={`/data/${ed.projectId}/${def.datasetId}/prepare?add=calculated_field`}>
        <Icon name="plus" />
        <span>Calculated field</span>
      </Link>
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
        <EmptyState compact heading={3} icon="chart-bar" title="No saved visuals yet">
          Make one in the Visuals builder, then add it here.
        </EmptyState>
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

/** The datasets the dashboard draws on, most-used first: where a dashboard filter's columns and values come from. */
function useSheetDatasets(): string[] {
  const ed = useEditor();
  const n = new Map<string, number>();
  for (const sh of ed.doc.sheets) {
    for (const c of sh.cards) {
      const id = c.type === 'visual' && c.visualId ? ed.visuals.get(c.visualId)?.datasetId : c.metric?.datasetId ?? c.control?.datasetId;
      if (id) n.set(id, (n.get(id) ?? 0) + 1);
    }
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * The dashboard-wide filters (the toolbar authoring.ts moved into this flyout):
 * the builder's own filter rows and typed dialog (values, conditions, ranges,
 * relative periods), applied to every card before its own — and the controls.
 */
function FiltersPane() {
  const ed = useEditor();
  const used = useSheetDatasets();
  const sets = useDatasets(ed.projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const dsId = picked ?? used[0] ?? sets.data?.[0]?.id ?? '';
  const cols = useDatasetColumns(ed.projectId, dsId || undefined);
  const steps = ed.doc.filters as FilterStep[];
  return (
    <div className={s.paneBody}>
      <p className={s.paneHint}>Dashboard filters apply to every card before its own. Controls sit above the sheet, where readers move them.</p>
      {(sets.data?.length ?? 0) > 1 && (
        <Select
          size="sm"
          label="Columns from"
          value={dsId}
          options={(sets.data ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
          onValueChange={setPicked}
        />
      )}
      {cols.isPending && dsId ? (
        <SkeletonRows rows={2} label="Reading the columns" />
      ) : cols.isError ? (
        <ErrorState compact heading={3} title="The columns could not be read" message={cols.error.message} onRetry={() => void cols.refetch()} />
      ) : !dsId ? (
        <p className={s.paneHint}>Import a dataset first — a filter narrows one.</p>
      ) : (
        <FilterRows
          projectId={ed.projectId}
          datasetId={dsId}
          cols={cols.data?.columns ?? []}
          filters={steps}
          onChange={(next) => ed.edit('Edit dashboard filters', (d) => void (d.filters = next))}
        />
      )}
      <QuickFilters datasetId={dsId} cols={cols.data?.columns ?? []} />
      {steps.length > 0 && (
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => ed.edit('Clear dashboard filters', (d) => void (d.filters = []))}>
          Clear all filters
        </button>
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
