// /data/import[?source=file|paste|screenshot|combine][&capture=<id>] — in the current project
//
// Bringing data in (legacy dsImport.ts + the Data section's import dialog):
// pick a source on the left, its panel on the right; every source ends in the
// COMPOSER, the one create-a-dataset surface. An input table is defined in a
// dialog and opens on its own grid. `capture=<id>` opens a stored capture's
// table in the composer (the Captures tab's "Save as dataset").

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { SkeletonTable } from '../../ui/Skeleton';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { toast } from '../../ui/Toast';
import { draftCapture } from './api';
import { Composer, type ComposerStart } from './Composer';
import { FileSource, PasteSource } from './FileSources';
import { InputColumnsDialog } from './InputColumnsDialog';
import { ProjectGate } from './ProjectGate';
import { ScreenshotSource } from './ScreenshotSource';
import { Button } from '../../ui/Button';
import s from './Import.module.css';

type Source = 'file' | 'paste' | 'screenshot' | 'input' | 'combine';

const SOURCES: readonly { id: Source; icon: IconName; label: string; hint: string }[] = [
  { id: 'file', icon: 'upload', label: 'Upload a file', hint: 'CSV, TSV, JSON, Excel or Parquet' },
  { id: 'paste', icon: 'clipboard', label: 'Paste data', hint: 'Cells from a spreadsheet, CSV or JSON' },
  { id: 'screenshot', icon: 'camera', label: 'Upload or paste a screenshot', hint: 'The model reads the table out of it' },
  { id: 'input', icon: 'table', label: 'Input table', hint: 'Type targets, budgets, mappings' },
  { id: 'combine', icon: 'layers', label: 'Combine datasets', hint: 'Join or append saved datasets' },
];

const isSource = (v: string | null): v is Source => SOURCES.some((x) => x.id === v);

function StoredCapture({ projectId, captureId, onComposer }: { projectId: string; captureId: string; onComposer: (s: ComposerStart) => void }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    draftCapture({ projectId, captureId }).then(
      (r) => {
        if (!live) return;
        if (!r.ok) return setError(r.message);
        onComposer({
          base: { label: r.title, rows: r.rows.length, kind: 'capture', ref: { inline: { name: r.title, columns: r.columns, rows: r.rows } }, columns: r.columns.map((c) => c.name) },
          name: r.title,
          sourceKind: 'capture',
          origin: { kind: 'capture', captureId: r.captureId },
          capture: true,
          unsure: r.unsure,
          warnings: r.warnings,
        });
      },
      (err: unknown) => live && setError(err instanceof Error ? err.message : 'The capture could not be opened.'),
    );
    return () => {
      live = false;
    };
  }, [projectId, captureId, onComposer]);
  if (error) return <ErrorState title="This capture could not be opened" message={error} heading={2} />;
  return <SkeletonTable label="Opening the capture" />;
}

function Importer({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [start, setStart] = useState<ComposerStart | null>(null);
  const source: Source = isSource(params.get('source')) ? (params.get('source') as Source) : 'file';
  const captureId = params.get('capture');
  const [defining, setDefining] = useState(false);

  const choose = (id: Source) => {
    const next = new URLSearchParams(params);
    next.set('source', id);
    next.delete('capture');
    setParams(next, { replace: true });
    if (id === 'combine') setStart({ base: null, name: '' });
    if (id === 'input') setDefining(true);
  };
  const back = () => {
    setStart(null);
    if (captureId) {
      const next = new URLSearchParams(params);
      next.delete('capture');
      setParams(next, { replace: true });
    }
  };

  if (start) {
    return (
      <Page title="New dataset" sub="Combine, map and check the columns, then save. Nothing is stored until you do.">
        <Composer projectId={projectId} start={start} onBack={back} />
      </Page>
    );
  }
  return (
    <Page title="Bring data in" sub="Choose a source. Every source opens in the composer, where you check the columns before anything is saved.">
      <div className={s.importer}>
        <nav className={s.sourceList} aria-label="Sources">
          {SOURCES.map((x) => (
            <button
              key={x.id}
              type="button"
              className={x.id === source && !captureId ? `${s.tile} ${s.tileOn}` : s.tile}
              aria-pressed={x.id === source && !captureId}
              onClick={() => choose(x.id)}
            >
              <span className={s.tileIcon} aria-hidden="true">
                <Icon name={x.icon} size={16} />
              </span>
              <span className={s.tileText}>
                <span className={s.tileLabel}>{x.label}</span>
                <span className={s.tileHint}>{x.hint}</span>
              </span>
            </button>
          ))}
        </nav>
        <section className={s.pane} aria-label={captureId ? 'Capture' : SOURCES.find((x) => x.id === source)?.label}>
          {captureId ? (
            <StoredCapture projectId={projectId} captureId={captureId} onComposer={setStart} />
          ) : source === 'paste' ? (
            <PasteSource onComposer={setStart} />
          ) : source === 'screenshot' ? (
            <ScreenshotSource projectId={projectId} onComposer={setStart} />
          ) : source === 'combine' || source === 'input' ? (
            <EmptyState
              icon={source === 'input' ? 'table' : 'layers'}
              heading={3}
              title={source === 'input' ? 'A table you type' : 'Combine saved datasets'}
              actions={
                <Button variant="primary" onClick={() => (source === 'input' ? setDefining(true) : setStart({ base: null, name: '' }))}>
                  {source === 'input' ? 'Define the columns' : 'Open the composer'}
                </Button>
              }
            >
              {source === 'input'
                ? 'Targets, budgets, a code mapping — define the columns, then type or paste the rows.'
                : 'Join or append the project’s datasets on one canvas, check the result, and save it as a new dataset.'}
            </EmptyState>
          ) : (
            <FileSource onComposer={setStart} />
          )}
        </section>
      </div>
      {defining && (
        <InputColumnsDialog
          projectId={projectId}
          mode="create"
          onClose={() => setDefining(false)}
          onDone={(id) => {
            setDefining(false);
            toast('Input table created — type or paste rows.', { kind: 'success' });
            void navigate(`/data/input/${projectId}/${id}`);
          }}
        />
      )}
    </Page>
  );
}

export default function ImportPage() {
  return (
    <ProjectGate title="Bring data in" why="A new dataset is saved in a project.">
      {(projectId) => <Importer key={projectId} projectId={projectId} />}
    </ProjectGate>
  );
}
