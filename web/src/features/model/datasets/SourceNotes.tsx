// "From the source table": the notes of the warehouse tables a dataset is built from, read-only, under
// the dataset's own Guide (docs/semantic-layer/02-source-tables.md, D10). Editors only: a viewer's web
// never asks `sourceTable:forDataset` and the server refuses it. A query dataset names its tables by
// hand (Link tables). The notes are written in the Source tables tab; here they are only read.

import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { ErrorState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import { MarkdownView } from '../../dashboards/Markdown';
import { useCanEdit } from '../../projects/api';
import { useDocumentTable } from '../sources/DocumentTable';
import { useSourceBlocks, type SourceBlock } from '../sources/linksApi';
import { LinkTablesDialog } from './LinkTablesDialog';
import n from './SourceNotes.module.css';

const keepToken = (name: string) => ({ text: `{{${name}}}`, missing: true });

/** `Owner X · refreshes Y · filter on Z · key K`: only the parts that are set. */
export function factLine(b: SourceBlock): string {
  return [
    b.owner && `Owner ${b.owner}`,
    b.refresh && `refreshes ${b.refresh}`,
    b.requiredFilters && `filter on ${b.requiredFilters}`,
    b.primaryKey && `key ${b.primaryKey.columns.join(', ')}`,
  ].filter(Boolean).join(' · ');
}

function Block({ projectId, b }: { projectId: string; b: SourceBlock }) {
  const documentTable = useDocumentTable(projectId);
  const [busy, setBusy] = useState(false);
  const write = async () => {
    setBusy(true);
    try {
      await documentTable(b.connId, b.table);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : 'The notes could not be started.', { kind: 'error' });
      setBusy(false);
    }
  };
  const to = `/model/${projectId}?tab=sources&conn=${b.connId}${b.docId ? `&doc=${b.docId}` : ''}`;
  const line = factLine(b);
  return (
    <section className={n.block} aria-label="From the source table">
      <header className={n.head}>
        <p className={n.title}>
          <span className={n.cap}>From the source table</span>
          <span aria-hidden="true">·</span>
          <span className={n.table}>{b.table}</span>
          <span>{`on ${b.connName}`}</span>
        </p>
        <Link className={n.open} to={to}>
          Open in Source tables
          <Icon name="external-link" size={12} />
        </Link>
      </header>
      {b.docId ? (
        <>
          {line && <p className={n.line}>{line}</p>}
          {b.guide && (
            <div className={n.guide}>
              <MarkdownView text={b.guide} token={keepToken} />
            </div>
          )}
          {!line && !b.guide && <p className={n.none}>{`The notes on ${b.table} are empty.`}</p>}
        </>
      ) : (
        <div className={n.empty}>
          <p className={n.none}>{`No notes on ${b.table} yet.`}</p>
          <Button size="sm" icon="pencil" loading={busy} onClick={() => void write()}>
            Write them
          </Button>
        </div>
      )}
    </section>
  );
}

function Notes({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const q = useSourceBlocks(projectId, datasetId, true);
  const [linking, setLinking] = useState(false);
  if (q.isPending) return null;
  if (q.isError) {
    return <ErrorState compact heading={3} title="The source notes could not be loaded" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  }
  const { linkable, byQuery, tables } = q.data;
  if (!linkable) return null;
  return (
    <div className={n.wrap}>
      {tables.map((b) => (
        <Block key={`${b.connId}\u0000${b.table}`} projectId={projectId} b={b} />
      ))}
      {byQuery && !tables.length && (
        <section className={n.block} aria-label="From the source table">
          <p className={n.none}>This dataset runs a query. Link the tables it reads so their notes show here.</p>
          <div>
            <Button size="sm" icon="link" onClick={() => setLinking(true)}>
              Link tables
            </Button>
          </div>
        </section>
      )}
      {byQuery && tables.length > 0 && (
        <div>
          <Button size="sm" variant="ghost" icon="link" onClick={() => setLinking(true)}>
            Change linked tables
          </Button>
        </div>
      )}
      {linking && <LinkTablesDialog projectId={projectId} datasetId={datasetId} onClose={() => setLinking(false)} />}
    </div>
  );
}

export function SourceNotes(p: { projectId: string; datasetId: string }) {
  return useCanEdit(p.projectId) ? <Notes {...p} /> : null;
}
