// The Data model's Source tables tab (docs/semantic-layer/02-source-tables.md D3-D5), an editor's only:
// what to fill in next above the tables datasets are built from, grouped by connection, and the picked
// table's panel. Laid out like Datasets. Records only: nothing here asks the warehouse. The address
// carries `conn` and `doc` ids, never a table name; a used table with no doc is picked in the page.

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { buttonClass } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonBlock, SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { ChipStrip } from '../datasets/TodoStrip';
import { sourceTodoPanel, sourceTodoText, useSourceTables, type SourceConn, type SourceTodo } from './api';
import { SourceList, type Picked } from './SourceList';
import { SourcePanel } from './SourcePanel';
import m from '../Model.module.css';

/** Also what the Data model shows while the roles are still unknown, so an editor's deep link is never bounced. */
export function SourcesLoading() {
  return (
    <div className={m.split}>
      <div className={m.list}>
        <SkeletonRows rows={4} label="Loading the source tables" />
      </div>
      <div className={`${m.panel} ${m.panelLoading}`}>
        <SkeletonBlock label="Loading a source table" />
      </div>
    </div>
  );
}

const todoKey = (t: SourceTodo) => `${t.connId}:${t.docId ?? `used:${t.table}`}:${t.kind}`;

/** The pick: a used table picked in the page, else `?conn&doc`, else the first documented table (of `?conn`, when set). */
function pickOf(conns: SourceConn[], loose: { connId: string; table: string } | null, connId: string | null, docId: string | null): Picked {
  const all = conns.flatMap((conn) => conn.rows.map((row) => ({ conn, row })));
  const inConn = connId ? all.filter((p) => p.conn.connId === connId) : all;
  return (
    (loose && all.find((p) => !p.row.docId && p.conn.connId === loose.connId && p.row.table === loose.table)) ||
    (docId && inConn.find((p) => p.row.docId === docId)) ||
    inConn.find((p) => p.row.docId) ||
    inConn[0] ||
    all.find((p) => p.row.docId) ||
    all[0]
  );
}

export function SourceTablesTab({ projectId }: { projectId: string }) {
  const list = useSourceTables(projectId);
  const [params, setParams] = useSearchParams();
  const [loose, setLoose] = useState<{ connId: string; table: string } | null>(null);

  const go = (connId: string, docId: string | undefined, panel = 'overview') => {
    setParams((p) => {
      const q = new URLSearchParams(p);
      q.set('conn', connId);
      if (docId) q.set('doc', docId);
      else q.delete('doc');
      if (panel === 'overview') q.delete('panel');
      else q.set('panel', panel);
      return q;
    }, { replace: true });
  };
  const pickLoose = (connId: string, table: string) => {
    setLoose({ connId, table });
    go(connId, undefined);
  };
  const hrefOf = (connId: string, docId: string) => {
    const q = new URLSearchParams(params);
    q.set('conn', connId);
    q.set('doc', docId);
    return `?${q.toString()}`;
  };

  let body;
  if (list.isError) {
    body = <ErrorState heading={3} title="Source tables could not be loaded" message={list.error?.message || 'Try again.'} onRetry={() => void list.refetch()} />;
  } else if (list.isPending) {
    body = <SourcesLoading />;
  } else if (!list.data.connections.some((c) => c.rows.length)) {
    body = (
      <EmptyState
        icon="database"
        heading={3}
        title="No source tables yet"
        actions={
          <Link className={buttonClass('primary')} to={`/connections/${projectId}`}>
            Open Connections
          </Link>
        }
      >
        Datasets you import from a connection show their tables here. Add one from a connection.
      </EmptyState>
    );
  } else {
    const { connections, todo, more } = list.data;
    const picked = pickOf(connections, loose, params.get('conn'), params.get('doc'));
    const readAtOf = (t: SourceTodo) => connections.find((c) => c.connId === t.connId)?.rows.find((r) => r.docId === t.docId)?.readAt;
    const open = (id: string) => {
      const t = todo.find((item) => todoKey(item) === id);
      if (!t) return;
      if (!t.docId) return pickLoose(t.connId, t.table);
      setLoose(null);
      go(t.connId, t.docId, sourceTodoPanel(t.kind));
    };
    body = (
      <>
        <ChipStrip items={todo.map((t) => ({ id: todoKey(t), text: sourceTodoText(t, readAtOf(t)), warn: t.kind === 'used_no_doc' }))} more={more} onPick={open} />
        <div className={m.split}>
          <SourceList conns={connections} picked={picked} hrefOf={hrefOf} onLoose={pickLoose} onLink={() => setLoose(null)} />
          <SourcePanel
            key={`${picked.conn.connId}:${picked.row.docId ?? `used:${picked.row.table}`}`}
            projectId={projectId}
            conn={picked.conn}
            row={picked.row}
            onStarted={(docId) => {
              setLoose(null);
              go(picked.conn.connId, docId);
            }}
            onDeleted={() => go(picked.conn.connId, undefined)}
          />
        </div>
      </>
    );
  }
  return (
    <>
      <p className={m.calendar}>
        <Icon name="lock" size={16} />
        <span>Tables in your databases and warehouses that datasets are built from. Only editors of this project see this tab.</span>
      </p>
      {body}
    </>
  );
}
