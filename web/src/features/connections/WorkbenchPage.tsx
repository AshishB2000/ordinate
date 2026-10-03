// /connections/:projectId/:connId — the connection workbench (legacy
// connWorkbench.ts + connEditor.ts + connDetails.ts): the schema tree, the
// SQL editor over its results, and the details rail, over ONE saved connection.
// A source with no catalog (HTTP engines, URL) has no tree: hiding it is the
// honest answer, the editor still works.

import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Button, buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { toast } from '../../ui/Toast';
import {
  describeTable,
  explainQuery,
  importDataset,
  qualify,
  runQuery,
  sampleTable,
  saveQuery,
  useCatalog,
  useConnections,
  useLogos,
  useProjectDatasets,
  useRefreshLists,
  useTables,
  type ColumnDetail,
  type Connection,
  type Connector,
  type Logo,
} from './api';
import { ConnLogo } from './ConnLogo';
import { DetailsRail, type TestState } from './DetailsRail';
import { Results, type ResultState, type Shown } from './Results';
import { describeKey, SchemaTree } from './SchemaTree';
import { SqlEditor } from './SqlEditor';
import { SavedQueries, type QueryDialog } from './SavedQueries';
import { where } from './SavedConnections';
import s from './Workbench.module.css';

export default function WorkbenchPage() {
  const { projectId = '', connId = '' } = useParams();
  const conns = useConnections(projectId);
  const catalog = useCatalog();
  const logos = useLogos();
  if (conns.isPending || catalog.isPending) return <PageSkeleton />;
  const failed = conns.error ?? catalog.error;
  if (failed) {
    return (
      <Page title="Connection">
        <ErrorState title="This connection could not be opened" message={failed.message} onRetry={() => {
          void conns.refetch();
          void catalog.refetch();
        }} />
      </Page>
    );
  }
  const conn = conns.data?.find((c) => c.id === connId);
  if (!conn) {
    return (
      <Page title="Connection">
        <EmptyState
          icon="plug"
          title="Connection not found"
          actions={
            <Link className={buttonClass('primary')} to={`/connections/${projectId}`}>
              Back to connections
            </Link>
          }
        >
          It may have been deleted, or it belongs to another project.
        </EmptyState>
      </Page>
    );
  }
  const def = catalog.data?.find((d) => d.id === conn.connectorId) ?? null;
  return <Workbench key={conn.id} projectId={projectId} conn={conn} def={def} logo={logos.data?.[conn.connectorId]} />;
}

function Workbench({ projectId, conn, def, logo }: { projectId: string; conn: Connection; def: Connector | null; logo?: Logo }) {
  const navigate = useNavigate();
  const refreshLists = useRefreshLists(projectId);
  const browsable = def?.browsable !== false;
  const family = def?.family ?? '';
  const [testAsked, setTestAsked] = useState(false);
  const tables = useTables(projectId, conn.id, browsable || testAsked);
  const datasets = useProjectDatasets(projectId);
  const [columns, setColumns] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  // The selected table lives in the URL (?table=), so a reload or a shared
  // link reopens its sample. A Run's result is held here and wins until the
  // next table is picked.
  const [params, setParams] = useSearchParams();
  const selected = params.get('table') ?? '';
  const [ran, setRan] = useState<Shown | null>(null);
  const sample = useQuery({
    queryKey: ['connection:sample', projectId, conn.id, selected],
    queryFn: () => sampleTable(projectId, conn.id, selected),
    enabled: selected !== '' && ran === null,
    retry: false,
  });
  const [sql, setSql] = useState('');
  const [queryId, setQueryId] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean; columns?: ColumnDetail[] } | null>(null);
  const [busy, setBusy] = useState<'run' | 'explain' | null>(null);
  const [saving, setSaving] = useState(false);
  const [limit, setLimit] = useState('100000');
  const [details, setDetails] = useState(true);
  const [dialog, setDialog] = useState<QueryDialog>(null);

  const keyOf = useCallback((table: string) => describeKey(projectId, conn.id, table), [projectId, conn.id]);
  const describe = useCallback(
    async (table: string) => {
      const r = await describeTable(projectId, conn.id, table);
      setColumns((m) => new Map(m).set(table, r ? r.columns.map((c) => c.name) : []));
      return r;
    },
    [projectId, conn.id],
  );
  const tableNames = useMemo(() => (tables.data ?? []).map(qualify), [tables.data]);

  function selectTable(table: string) {
    setRan(null);
    setMessage(null);
    setParams({ table }, { replace: true });
  }
  // The selected table's columns, in the background — for autocomplete (the
  // next thing typed likely names them) and the tree's row estimate. Shares
  // the tree's cache entry, so it is one describe per table.
  useQuery({ queryKey: keyOf(selected), queryFn: () => describe(selected), enabled: selected !== '', staleTime: Infinity, retry: false });

  const result: ResultState = ran
    ? { kind: 'shown', shown: ran }
    : !selected
      ? { kind: 'idle' }
      : sample.isPending
        ? { kind: 'loading', what: `Loading ${selected}` }
        : sample.isError
          ? { kind: 'error', message: sample.error.message, retry: () => void sample.refetch() }
          : { kind: 'shown', shown: { preview: sample.data, table: selected, sql: '', name: selected } };

  async function run() {
    const text = sql.trim();
    if (!text) return setMessage({ text: 'Write a query first.', error: true });
    setBusy('run');
    setMessage({ text: 'Running…', error: false });
    try {
      const preview = await runQuery(projectId, conn.id, text);
      setMessage(null);
      // The grid now shows the query's rows; a highlighted table would claim otherwise.
      setParams({}, { replace: true });
      setRan({ preview, table: '', sql: text, name: conn.queries.find((q) => q.id === queryId)?.name || 'Query result' });
    } catch (err) {
      // The dialect's own message, where the query is.
      setMessage({ text: err instanceof Error ? err.message : 'Could not run the query.', error: true });
    } finally {
      setBusy(null);
    }
  }

  async function explain() {
    const text = sql.trim();
    if (!text) return setMessage({ text: 'Write a query first.', error: true });
    setBusy('explain');
    setMessage({ text: 'Checking…', error: false });
    try {
      const cols = await explainQuery(projectId, conn.id, text);
      setMessage({ text: cols.length === 1 ? 'Returns 1 column' : `Returns ${cols.length} columns`, error: false, columns: cols });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Could not check the query.', error: true });
    } finally {
      setBusy(null);
    }
  }

  /** ⌘S / Save query: update the loaded query in place, or name a new one. */
  async function saveCurrent() {
    const text = sql.trim();
    if (!text) return setMessage({ text: 'Write a query first.', error: true });
    const loaded = conn.queries.find((q) => q.id === queryId);
    if (!loaded) return setDialog({ kind: 'create', suggested: selected || 'Query' });
    try {
      await saveQuery(projectId, conn.id, { id: loaded.id, sql: text });
      setMessage({ text: `Saved “${loaded.name}”.`, error: false });
      refreshLists();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Could not save that query.', error: true });
    }
  }

  async function saveAsDataset(name: string) {
    if (result.kind !== 'shown') return;
    const { table, sql: stmt } = result.shown;
    setSaving(true);
    try {
      const ds = await importDataset({
        projectId,
        connId: conn.id,
        name: name || table || 'Connection data',
        ...(stmt ? { sql: stmt, ...(queryId ? { queryId } : {}) } : { table }),
        limit: Number(limit),
      });
      refreshLists();
      toast(`Saved “${ds.name}” as a dataset.`, { kind: 'success', action: { label: 'Open', onClick: () => void navigate(`/data/${projectId}/${ds.id}`) } });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the dataset.', { kind: 'error' });
    } finally {
      setSaving(false);
    }
  }

  const test: TestState = tables.isFetching ? 'testing' : tables.isError ? 'error' : tables.isSuccess ? 'ok' : conn.lastStatus;
  const testError = tables.isError ? tables.error.message : conn.lastStatus === 'error' ? conn.lastError ?? '' : '';
  const label = def?.label ?? conn.connectorId;
  const at = where(conn);
  const mine = (datasets.data ?? []).filter((d) => d.originConnId === conn.id);

  return (
    <div className={s.page}>
      <header className={s.head}>
        <Link className={buttonClass('secondary', 'sm')} to={`/connections/${projectId}`}>
          <Icon name="arrow-left" />
          <span>Connections</span>
        </Link>
        <ConnLogo logo={logo} label={label} small />
        <div className={s.ident}>
          <h1 className={s.title}>{conn.name}</h1>
          <span className={s.sub}>{at ? `${label} · ${at}` : label}</span>
        </div>
        <Button size="sm" icon="sliders" aria-expanded={details} aria-controls="conn-wb-details" onClick={() => setDetails(!details)}>
          Details
        </Button>
      </header>
      <div className={[s.body, !browsable && s.noTree, !details && s.noDetails].filter(Boolean).join(' ')}>
        {browsable && <SchemaTree tables={tables} family={family} selected={selected} keyOf={keyOf} describe={describe} onSelect={selectTable} />}
        <div className={`${s.pane} ${s.main}`}>
          <SqlEditor
            sql={sql}
            onSql={setSql}
            family={family}
            tables={tableNames}
            columns={columns}
            limit={limit}
            onLimit={setLimit}
            busy={busy}
            onRun={() => void run()}
            onExplain={() => void explain()}
            onSave={() => void saveCurrent()}
          />
          {message && (
            <div className={s.msgRow} role={message.error ? 'alert' : 'status'}>
              <p className={message.error ? `${s.msg} ${s.msgError}` : s.msg}>{message.text}</p>
              {message.columns && (
                <div className={s.chips}>
                  {message.columns.map((c) => (
                    <span key={c.name} className={s.colChip}>
                      <span className={s.colChipName}>{c.name}</span>
                      <span className={s.colChipType}>{c.type}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          <SavedQueries
            projectId={projectId}
            conn={conn}
            sql={sql}
            current={queryId}
            dialog={dialog}
            onDialog={setDialog}
            onOpen={(q) => (setQueryId(q.id), setSql(q.sql), setMessage(null))}
            onCurrent={setQueryId}
            onChanged={refreshLists}
            onMessage={(text, error) => setMessage({ text, error })}
          />
          <Results state={result} saving={saving} onSave={(n) => void saveAsDataset(n)} />
        </div>
        {details && (
          <DetailsRail
            conn={conn}
            def={def}
            projectId={projectId}
            test={test}
            testError={testError}
            onTest={() => (browsable || testAsked ? void tables.refetch() : setTestAsked(true))}
            datasets={mine}
            onChanged={refreshLists}
          />
        )}
      </div>
    </div>
  );
}
