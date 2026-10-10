// The builder's layout (see ./BuilderPage.tsx for the loading, ./builderState
// for the draft): a header (Back, the name, the dataset, Suggest chart,
// History, Save), the controls rail (encoding, small multiples, filters,
// analytics, the server's warnings) and the stage (./Stage).

import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { DatasetSummary } from '../../api/datasets';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { useAiStatus } from '../assistant/api';
import { AI_NOT_READY } from '../assistant/AiNotReady';
import { AnalyticsPane } from './analytics/AnalyticsPane';
import type { RelatedCol } from './api';
import { useBuilder, type Initial } from './builderState';
import { EncodingForm } from './EncodingForm';
import { FacetShelf, type Facet } from './facets/FacetShelf';
import { FilterRows } from './filters/FilterRows';
import { fitEncoding, type Column } from './model';
import { NameDialog } from './NameDialog';
import { NewVisualDialog } from './NewVisualDialog';
import { Stage } from './Stage';
import { AsOfPicker } from '../analytics/snapshots/AsOfPicker';
import { EngineShelves } from '../analytics/grids/EngineShelves';
import { engineKind, engineNeeds, pivotEncoding, type Pivot } from '../analytics/grids/gridEncoding';
import { PivotShelves } from '../analytics/grids/PivotShelves';
import s from './Builder.module.css';
import { CommentDoor } from '../dashboards/CommentsPanel';

export type { Initial };

export function Editor({ projectId, datasets, columns, related, initial }: {
  projectId: string;
  datasets: DatasetSummary[];
  columns: Column[];
  related: RelatedCol[];
  initial: Initial;
}) {
  const navigate = useNavigate();
  const ai = useAiStatus();
  const b = useBuilder(projectId, columns, related, initial);
  const [naming, setNaming] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const { visualId, datasetId } = b;

  // Which shelves the rail shows: the encoding's own block says (./builderState switches it with the type).
  const pivot = b.enc.pivot as Pivot | undefined;
  const engine = b.enc.cohort ? 'cohort' : b.enc.eventFunnel ? 'event_funnel' : '';
  const trySave = () => {
    const needs = engineKind(b.current) ? engineNeeds(engineKind(b.current) as 'cohort' | 'event_funnel', b.eff) : '';
    if (needs) {
      toast(needs, { kind: 'error' });
      return;
    }
    if (b.current === 'pivot' && (!pivot?.rows.length || !pivot.values.length)) {
      toast('Pick a row dimension and at least one value to build a pivot.', { kind: 'error' });
      return;
    }
    if (!b.complete) {
      toast('Pick a category and at least one measure before saving.', { kind: 'error' });
      return;
    }
    setNaming(true);
  };
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
          {/* "As of" reads a kept snapshot; a Live dataset keeps none (L2.6). */}
          {!b.liveDataset && <AsOfPicker projectId={projectId} datasetIds={[datasetId]} value={b.asOf} onChange={b.setAsOf} />}
          <Button
            size="sm"
            icon="sparkles"
            disabled={!ai.data?.ready}
            title={ai.data && !ai.data.ready ? AI_NOT_READY : undefined}
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
          {/* Comments on this visual (T2.9 commentDoors.ts) — a saved visual only. */}
          <CommentDoor projectId={projectId} kind="visual" id={visualId ?? undefined} disabledReason="Save this visual first, then comment on it" />
          {visualId && (
            <Button size="sm" icon="history" title="Version history" onClick={() => void navigate(`/versions/${projectId}/visual/${visualId}`)}>
              History
            </Button>
          )}
          {b.canEdit ? (
            <Button variant="primary" onClick={trySave}>
              Save visual
            </Button>
          ) : (
            <Badge icon="eye">View only</Badge>
          )}
        </div>
      </header>

      <div className={s.body}>
        <aside className={s.rail} aria-label="Encoding">
          {pivot ? (
            <PivotShelves projectId={projectId} cols={columns} pivot={pivot} onChange={(p) => b.setEnc(pivotEncoding(p, b.enc.facet))} />
          ) : engine ? (
            <EngineShelves kind={engine} projectId={projectId} datasetId={datasetId} cols={columns} encoding={b.enc} onChange={b.setEnc} />
          ) : (
            <EncodingForm projectId={projectId} cols={columns} related={related} encoding={b.enc} info={b.reply?.category} onChange={b.setEnc} />
          )}
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
