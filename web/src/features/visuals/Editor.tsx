// The builder's layout (see ./BuilderPage.tsx for the loading, ./builderState
// for the draft): a header (Back, the name, the dataset, Suggest chart,
// History, Save), the controls rail (encoding, small multiples, filters,
// analytics, the server's warnings) and the stage (./Stage).

import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { DatasetSummary } from '../../api/datasets';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { useKeyStatus } from '../assistant/api';
import { AnalyticsPane } from './analytics/AnalyticsPane';
import type { RelatedCol } from './api';
import { useBuilder, type Initial } from './builderState';
import { GRID_TYPES } from './eligibility';
import { EncodingForm } from './EncodingForm';
import { FacetShelf, type Facet } from './facets/FacetShelf';
import { FilterRows } from './filters/FilterRows';
import { fitEncoding, type Column } from './model';
import { NameDialog } from './NameDialog';
import { NewVisualDialog } from './NewVisualDialog';
import { Stage } from './Stage';
import s from './Builder.module.css';

export type { Initial };

export function Editor({ projectId, datasets, columns, related, initial }: {
  projectId: string;
  datasets: DatasetSummary[];
  columns: Column[];
  related: RelatedCol[];
  initial: Initial;
}) {
  const navigate = useNavigate();
  const ai = useKeyStatus();
  const b = useBuilder(projectId, columns, related, initial);
  const [naming, setNaming] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const { visualId, datasetId } = b;

  const trySave = () => {
    if (GRID_TYPES.has(b.current) && !b.eff.pivot && !b.eff.cohort && !b.eff.eventFunnel) {
      toast(`${b.current === 'pivot' ? 'Pivot tables' : 'This grid'} can’t be built in the browser yet — pick another chart type to save.`, { kind: 'error' });
      return;
    }
    if (!b.complete) {
      toast('Pick a category and at least one measure before saving.', { kind: 'error' });
      return;
    }
    setNaming(true);
  };
  const engine = b.current === 'cohort' || b.current === 'event_funnel'; // a cohort / funnel is already its own grid
  const warnings = b.reply?.warnings ?? [];

  return (
    <div className={s.builder}>
      <header className={s.head}>
        <Button icon="arrow-left" onClick={() => void navigate(`/visuals/${projectId}`)}>
          Back
        </Button>
        <h1 className={s.name}>{initial.name || 'New visual'}</h1>
        <div className={s.headActions}>
          <Select
            label="Dataset"
            className={s.dataset}
            size="sm"
            value={datasetId}
            options={datasets.map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
            // Another dataset starts a fresh build — the open visual and its styling stay as saved.
            onValueChange={(id) => void navigate(`/visuals/${projectId}/new?dataset=${encodeURIComponent(id)}`)}
          />
          <Button
            size="sm"
            icon="sparkles"
            disabled={!ai.data?.isReady}
            title={ai.data && !ai.data.isReady ? 'The Assistant isn’t set up yet.' : undefined}
            onClick={() => setSuggesting(true)}
          >
            Suggest chart
          </Button>
          <Button
            size="sm"
            icon="database"
            title="Open this dataset, profiling the category column"
            // The profile panel is the Data section's (T2.3): link to it, never a second copy here.
            onClick={() => void navigate(`/data/${projectId}/${datasetId}${b.eff.category ? `?profile=${encodeURIComponent(b.eff.category)}` : ''}`)}
          >
            Profile
          </Button>
          {visualId && (
            <Button size="sm" icon="history" title="Version history" onClick={() => void navigate(`/versions/${projectId}/visual/${visualId}`)}>
              History
            </Button>
          )}
          <Button variant="primary" onClick={trySave}>
            Save visual
          </Button>
        </div>
      </header>

      <div className={s.body}>
        <aside className={s.rail} aria-label="Encoding">
          <EncodingForm projectId={projectId} cols={columns} related={related} encoding={b.enc} info={b.reply?.category} onChange={b.setEnc} />
          {!engine && (
            <FacetShelf
              cols={columns}
              facet={b.enc.facet as Facet | undefined}
              onChange={(facet) => {
                const { facet: _gone, ...rest } = b.enc;
                b.setEnc(facet ? { ...rest, facet } : rest);
              }}
            />
          )}
          <FilterRows projectId={projectId} datasetId={datasetId} cols={columns} filters={b.filters} onChange={b.setFilters} />
          <AnalyticsPane type={b.current} data={b.data} overlays={b.overlays} onChange={b.setOverlays} />
          {warnings.length > 0 && (
            <div className={s.warnings} role="status">
              {warnings.map((w, i) => (
                <div key={i} className={s.warning}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </aside>
        <Stage projectId={projectId} b={b} />
      </div>

      {naming && (
        <NameDialog name={b.label} title={visualId ? 'Rename this visual' : 'Name this visual'} action="Save" onClose={() => setNaming(false)} onRename={b.save} />
      )}
      {suggesting && (
        <NewVisualDialog
          projectId={projectId}
          datasetId={datasetId}
          startAtSuggest
          onClose={() => setSuggesting(false)}
          onChoose={(c) => {
            setSuggesting(false);
            if (c.kind !== 'suggested') return;
            b.setEnc(fitEncoding(c.encoding, columns, related));
            if (c.chartType) b.setChartType(c.chartType);
          }}
        />
      )}
    </div>
  );
}
