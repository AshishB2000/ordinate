// The picked source table's panel: its name, the connection it is on, when it was last read, and its
// tabs (?panel=): Overview, Columns and Guide, with Edit for its notes. Opening any of it reads the doc only; Read from warehouse is
// the one thing that asks the warehouse, on a click. A table datasets are built from that has no doc
// yet shows its Overview and Start its notes, which creates the empty doc and then puts its id (never
// its name) in the address.

import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../../ui/Badge';
import { Button, type ButtonVariant } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { Tab, TabList, TabPanel, Tabs } from '../../../ui/Tabs';
import { ConnLogo } from '../../connections/ConnLogo';
import { useEditGuard, useReload } from '../../editConflicts/useEditGuard';
import { useLogos } from '../../connections/api';
import { ago } from '../../data/format';
import { GET, LIST, startNotes, useReadFacts, useSourceDoc, type SourceConn, type SourceFacts, type SourceRow } from './api';
import { SourceColumns } from './SourceColumns';
import { SourceDocForm } from './SourceDocForm';
import { SourceGuide } from './SourceGuide';
import { SourceOverview } from './SourceOverview';
import m from '../Model.module.css';
import x from './Sources.module.css';

const PANELS = ['overview', 'columns', 'guide'] as const;
type PanelId = (typeof PANELS)[number];
/** Restated from the server's STALE_DAYS (src/app/sourceTableList.ts; the web cannot import it): the strip's "read over 30 days ago". */
const STALE_DAYS = 30;

/** A refusal said where it happened, with the way on. */
export function Alert({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className={x.alert} role="alert">
      <Icon name="alert" size={16} />
      <span className={x.alertText}>{children}</span>
      {onRetry && (
        <Button size="sm" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function ReadLine({ facts }: { facts: SourceFacts | undefined }) {
  if (!facts) return <>Never read</>;
  const when = ago(facts.readAt);
  if (Date.now() - Date.parse(facts.readAt) <= STALE_DAYS * 86_400_000) return <>{`Read ${when} by ${facts.readBy}`}</>;
  return (
    <>
      <Badge tone="warn" icon="history">{`read ${when}`}</Badge>
      <span>{`by ${facts.readBy}`}</span>
    </>
  );
}

function Frame({ conn, table, badge, sub, desc, actions, children }: { conn: SourceConn; table: string; badge?: ReactNode; sub: ReactNode; desc?: string; actions?: ReactNode; children: ReactNode }) {
  const logos = useLogos().data ?? {};
  return (
    <section className={m.panel} aria-label={`About ${table}`}>
      <div className={m.panelHead}>
        <div className={x.headMain}>
          <div>
            <div className={m.panelTitle}>
              <h2>
                <span className={x.mono}>{table}</span>
              </h2>
              {badge}
            </div>
            {desc && <p className={m.desc}>{desc}</p>}
          </div>
          <div className={x.ident}>
            <ConnLogo small logo={logos[conn.connectorId]} label={conn.label} />
            <div>
              <p className={x.connName}>
                {conn.name} <span className={m.muted}>{`· ${conn.label}`}</span>
              </p>
              <p className={x.readLine}>{sub}</p>
            </div>
          </div>
        </div>
        {actions && <div className={x.actions}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

interface DocProps {
  projectId: string;
  conn: SourceConn;
  row: SourceRow;
  docId: string;
  onDeleted: () => void;
}

function DocPanel({ projectId, conn, row, docId, onDeleted, onReload }: DocProps & { onReload: () => void }) {
  const got = useSourceDoc(projectId, conn.connId, docId);
  const read = useReadFacts(projectId, conn.connId, docId);
  // One guard for the panel's life: its base moves with this editor's own saves, so reopening the form never conflicts with itself.
  const guard = useEditGuard({ projectId, type: 'sourceTable', id: docId }, got.data?.tag);
  const [editing, setEditing] = useState<'' | 'all' | 'guide'>('');
  const [params, setParams] = useSearchParams();
  const asked = params.get('panel');
  const panel: PanelId = (PANELS as readonly string[]).includes(asked ?? '') ? (asked as PanelId) : 'overview';
  const setPanel = (v: string) =>
    setParams((p) => {
      const q = new URLSearchParams(p);
      if (v === 'overview') q.delete('panel');
      else q.set('panel', v);
      return q;
    }, { replace: true });

  const doc = got.data?.doc;
  const readButton = (variant: ButtonVariant) => (
    <Button variant={variant} icon={doc?.facts ? 'refresh' : 'download'} loading={read.isPending} onClick={() => read.mutate()}>
      {doc?.facts ? 'Read again' : 'Read from warehouse'}
    </Button>
  );
  const actions = doc && (
    <>
      <div className={m.panelActions}>
        <Button icon="pencil" onClick={() => setEditing('all')}>
          Edit
        </Button>
        {conn.readsFacts && readButton('secondary')}
      </div>
      {conn.readsFacts && conn.factsWake && (
        <p className={x.wake}>
          <Icon name="zap" size={12} />
          <span>Reading runs on the SQL warehouse and can start it.</span>
        </p>
      )}
    </>
  );

  let body;
  if (got.isPending) {
    body = (
      <div className={m.bodyLoading}>
        <SkeletonBlock label={`Loading ${row.table}`} />
      </div>
    );
  } else if (got.isError) {
    body = <ErrorState heading={3} title={`${row.table} could not be loaded`} message={got.error.message || 'Try again.'} onRetry={() => void got.refetch()} />;
  } else {
    const d = got.data.doc;
    body = (
      <>
        {read.isError && <Alert onRetry={() => read.mutate()}>{read.error.message}</Alert>}
        <Tabs value={panel} onValueChange={setPanel}>
          <TabList label={`About ${d.table}`}>
            <Tab value="overview" icon="info">
              Overview
            </Tab>
            <Tab value="columns" icon="columns">
              Columns
            </Tab>
            <Tab value="guide" icon="file-text">
              Guide
            </Tab>
          </TabList>
          <TabPanel value="overview">
            <SourceOverview projectId={projectId} conn={conn} doc={d} datasets={got.data.datasets} />
          </TabPanel>
          <TabPanel value="columns">
            <SourceColumns conn={conn} doc={d} readButton={readButton('primary')} />
          </TabPanel>
          <TabPanel value="guide">
            <SourceGuide doc={d} onWrite={() => setEditing('guide')} />
          </TabPanel>
        </Tabs>
        {editing && (
          <SourceDocForm
            projectId={projectId}
            connId={conn.connId}
            doc={d}
            guard={guard}
            atGuide={editing === 'guide'}
            onClose={() => setEditing('')}
            onDeleted={onDeleted}
            onReload={onReload}
          />
        )}
      </>
    );
  }
  return (
    <Frame conn={conn} table={row.table} sub={doc ? <ReadLine facts={doc.facts} /> : 'Loading…'} desc={doc?.facts?.comment} actions={actions}>
      {body}
    </Frame>
  );
}

function UsedPanel({ projectId, conn, row, onStarted }: { projectId: string; conn: SourceConn; row: SourceRow; onStarted: (docId: string) => void }) {
  const client = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState('');
  const start = async () => {
    setStarting(true);
    setProblem('');
    try {
      const docId = await startNotes(projectId, conn.connId, row.table);
      await client.invalidateQueries({ queryKey: [LIST, projectId] });
      onStarted(docId);
    } catch (err) {
      setProblem(err instanceof Error && err.message ? err.message : 'The notes could not be started.');
      setStarting(false);
    }
  };
  const actions = (
    <div className={m.panelActions}>
      <Button variant="primary" icon="pencil" loading={starting} onClick={() => void start()}>
        Start its notes
      </Button>
    </div>
  );
  return (
    <Frame conn={conn} table={row.table} badge={<Badge tone="warn">no doc</Badge>} sub="No notes yet: datasets are built from it" actions={actions}>
      {problem && <Alert>{problem}</Alert>}
      <SourceOverview projectId={projectId} conn={conn} used={row.datasetIds.length} />
    </Frame>
  );
}

/** Reload after a conflict reads the doc again, then mounts a new panel on it: a new guard, the new tag. */
function DocHost(props: DocProps) {
  const { gen, reload } = useReload([GET, props.projectId, props.conn.connId, props.docId]);
  return <DocPanel key={gen} {...props} onReload={reload} />;
}

export function SourcePanel({ projectId, conn, row, onStarted, onDeleted }: { projectId: string; conn: SourceConn; row: SourceRow; onStarted: (docId: string) => void; onDeleted: () => void }) {
  return row.docId ? (
    <DocHost projectId={projectId} conn={conn} row={row} docId={row.docId} onDeleted={onDeleted} />
  ) : (
    <UsedPanel projectId={projectId} conn={conn} row={row} onStarted={onStarted} />
  );
}
