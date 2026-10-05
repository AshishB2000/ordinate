// /analytics/:projectId/sql[?dataset=<id>] — SQL over THIS project's datasets
// (queryTab.ts): the datasets on the left, the editor and its parameters, the
// bounded result. The server does all of it — the read-only gate, the org
// worker's engine lock, binding `[[params]]`, the 500-row preview; the browser
// sends the user's own text. "Save as dataset" reads the whole result on the
// server and opens the ORDINARY composer on it with the `sql` origin, so the
// dataset re-runs the statement on refresh. `?dataset=` opens a SQL dataset's
// own statement ("View query") and runs it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { formatNumber } from '../../../../../src/app/format.ts';
import { PageSkeleton } from '../../../app/blocks';
import { buttonClass } from '../../../ui/Button';
import { DataGrid } from '../../../ui/DataGrid/DataGrid';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonTable } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { useCaret } from '../../../ui/useCaret';
import { Composer, type ComposerStart } from '../../import/Composer';
import { useAdoptProject } from '../../projects/current';
import { explainSql, prepareSave, runSql, useDatasetQuery, useSchema, type RunResult } from './api';
import { ParamsRow, QueryEditor } from './QueryEditor';
import { QueryTree } from './QueryTree';
import { collectParams, guessKind, insertAt, scan, starter, type ParamEntry } from './sqlText';
import a from '../Analytics.module.css';
import w from '../../connections/Workbench.module.css';
import s from './Sql.module.css';

type Result =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'error'; heading: string; message: string }
  | { kind: 'shown'; r: RunResult };

const plural = (n: number, one: string) => `${formatNumber(n)} ${one}${n === 1 ? '' : 's'}`;

function Head({ projectId }: { projectId: string }) {
  return (
    <header className={a.head}>
      <div className={`${a.ident} ${s.identGrow}`}>
        <h1 className={a.title}>
          <span className={a.mark} aria-hidden="true">
            <Icon name="code" />
          </span>
          SQL query
        </h1>
        <p className={a.sub}>Every dataset in this project is a table — join, filter and aggregate them, then save the result as a dataset that stays up to date.</p>
      </div>
      <div className={a.actions}>
        <Link className={buttonClass('secondary', 'sm')} to={`/analytics?project=${projectId}`}>
          <Icon name="x" />
          Analytics
        </Link>
      </div>
    </header>
  );
}

function Workbench({ projectId }: { projectId: string }) {
  const [params] = useSearchParams();
  const schema = useSchema(projectId);
  const viewed = useDatasetQuery(projectId, params.get('dataset'));
  const input = useRef<HTMLTextAreaElement>(null);
  const place = useCaret(input);
  const [sql, setSql] = useState('');
  const [state, setState] = useState<ReadonlyMap<string, ParamEntry>>(new Map());
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const [explained, setExplained] = useState<Array<{ name: string; sqlType: string; kind: string }> | null>(null);
  const [busy, setBusy] = useState<'run' | 'explain' | null>(null);
  const [seen, setSeen] = useState(false); // the result on screen is for the text and values as they are
  const [saving, setSaving] = useState(false);
  const [composer, setComposer] = useState<ComposerStart | null>(null);
  const datasets = schema.data ?? [];
  const placeholder = starter(datasets);
  const rows = result.kind === 'shown' ? result.r.rows : null;
  // One reader per result: a new function is a new query to the grid.
  const readRows = useMemo(() => async (offset: number, limit: number) => ({ rows: (rows ?? []).slice(offset, offset + limit), total: rows?.length ?? 0 }), [rows]);

  // Every parameter the text names has an entry (a first guess at its type).
  const entries = useMemo(() => {
    const m = new Map(state);
    for (const n of scan(sql).params) if (!m.has(n)) m.set(n, { kind: guessKind(n), value: '' });
    return m;
  }, [sql, state]);

  const edit = (next: string) => {
    setSql(next);
    setSeen(false);
  };

  async function go(kind: 'run' | 'explain', text = sql, values = entries) {
    if (busy) return;
    let q = text;
    if (!q.trim()) {
      if (!datasets.some((d) => d.queryable)) {
        setResult({ kind: 'error', heading: 'Nothing to run', message: 'Write a query first.' });
        return;
      }
      q = placeholder; // the starter, put in the editor so what runs is what you see
      setSql(q);
    }
    const { params: p, error } = collectParams(q, values);
    if (error) {
      setResult({ kind: 'error', heading: 'A parameter needs a value', message: error });
      return;
    }
    setBusy(kind);
    if (kind === 'run') {
      setResult({ kind: 'running' });
      setExplained(null);
      const r = await runSql(projectId, q, p);
      setResult(r.ok ? { kind: 'shown', r } : { kind: 'error', heading: 'The query did not run', message: r.error || 'The query failed.' });
      setSeen(r.ok);
    } else {
      const r = await explainSql(projectId, q, p);
      if (r.ok) setExplained(r.columns);
      else setResult({ kind: 'error', heading: 'The query is not valid', message: r.error || 'The query could not be checked.' });
    }
    setBusy(null);
  }

  // "View query": the dataset's statement and its parameters, run once.
  const opened = useRef(false);
  useEffect(() => {
    const v = viewed.data;
    if (!v || opened.current || !schema.data) return;
    opened.current = true;
    const m = new Map<string, ParamEntry>();
    for (const p of v.params) m.set(p.name, { kind: p.kind, value: Array.isArray(p.value) ? p.value.join(', ') : p.value == null ? '' : String(p.value) });
    setState(m);
    setSql(v.sql);
    void go('run', v.sql, m);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `go` reads its text and values from its arguments; run once per opened dataset
  }, [viewed.data, schema.data]);

  const insert = (text: string) => {
    const el = input.current;
    const at = el?.selectionStart ?? sql.length;
    const next = insertAt(sql, at, el?.selectionEnd ?? at, text);
    edit(next.value);
    place(next.caret);
  };

  async function save() {
    if (!seen || saving) return;
    const { params: p } = collectParams(sql, entries);
    setSaving(true);
    const r = await prepareSave(projectId, sql, p);
    setSaving(false);
    if (!r.ok) {
      if (!r.canceled) setResult({ kind: 'error', heading: 'The result was not saved', message: r.error || 'The full result could not be read.' });
      return;
    }
    const first = datasets.find((d) => d.id === r.origin.deps[0]);
    const name = first ? `${first.name} query` : 'Query result';
    setComposer({
      base: { label: name, rows: r.rowCount, kind: 'sql', ref: { inline: { name, stagedId: r.stagedId } }, columns: r.columns.map((c) => c.name) },
      name,
      sourceKind: 'sql',
      origin: r.origin,
    });
  }

  if (composer) {
    return (
      <div className={s.composer}>
        <Composer projectId={projectId} start={composer} onBack={() => setComposer(null)} />
      </div>
    );
  }
  if (schema.isPending) return <SkeletonTable rows={6} cols={3} label="Loading the datasets" />;
  if (schema.isError) return <ErrorState title="Could not read the datasets" message={schema.error.message} onRetry={() => void schema.refetch()} />;
  if (!datasets.length) {
    return (
      <EmptyState
        icon="code"
        title="Nothing to query yet"
        actions={
          <>
            <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
              Import a file
            </Link>
            <Link className={buttonClass('ghost')} to={`/connections/${projectId}`}>
              Connect data
            </Link>
          </>
        }
      >
        Every dataset in this project becomes a table you can query with SQL — join them, filter them, aggregate them, and save the result as a dataset that stays up to date.
      </EmptyState>
    );
  }

  const shown = result.kind === 'shown' ? result.r : null;
  const status = busy === 'run' ? 'Running…' : busy === 'explain' ? 'Checking…' : result.kind === 'error' ? 'Error' : explained ? `Valid · returns ${plural(explained.length, 'column')}` : shown ? `${shown.truncated ? `First ${formatNumber(shown.rowCount)} rows` : plural(shown.rowCount, 'row')} · ${formatNumber(shown.elapsedMs)} ms` : '';
  return (
    <div className={`${w.body} ${w.noDetails} ${s.body}`}>
      <QueryTree schema={datasets} onInsert={insert} />
      <div className={`${w.pane} ${w.main}`}>
        <QueryEditor
          input={input}
          sql={sql}
          onSql={edit}
          placeholder={placeholder}
          schema={datasets}
          busy={busy}
          canSave={seen && !!shown && shown.columns.length > 0}
          saving={saving}
          onRun={() => void go('run')}
          onExplain={() => void go('explain')}
          onSave={() => void save()}
        />
        <ParamsRow
          sql={sql}
          state={entries}
          onChange={(n, e) => {
            setState(new Map(entries).set(n, e));
            setSeen(false);
          }}
          onRun={() => void go('run')}
        />
        <section className={w.results} aria-label="Results">
          <div className={w.resultsHead}>
            <span className={result.kind === 'error' ? `${w.note} ${s.statusErr}` : w.note} role="status">
              {status}
            </span>
            {shown && <span className={`${w.note} ${s.noteEnd}`}>{`${plural(shown.columns.length, 'column')}${shown.truncated ? ' · showing the first 500 — Save as dataset keeps them all' : ''}`}</span>}
          </div>
          {explained && (
            <ul className={w.chips} aria-label="Columns it returns">
              {explained.map((c) => (
                <li key={c.name} className={w.colChip}>
                  <span className={w.colChipName}>{c.name}</span>
                  <span className={w.colChipType}>{c.sqlType + (c.kind && c.kind !== 'text' ? ` → ${c.kind}` : '')}</span>
                </li>
              ))}
            </ul>
          )}
          {result.kind === 'running' ? (
            <SkeletonTable rows={8} cols={4} label="Running the query" />
          ) : result.kind === 'error' ? (
            <ErrorState compact heading={3} title={result.heading} message={result.message} />
          ) : shown ? (
            shown.columns.length === 0 ? (
              <EmptyState compact heading={3} icon="table" title="Nothing came back">
                The statement ran but returned no columns.
              </EmptyState>
            ) : (
              <div className={w.grid}>
                <DataGrid
                  columns={shown.columns}
                  source={readRows}
                  label="Query results"
                  emptyTitle="No rows"
                  emptyBody="The query returned columns but no rows."
                />
              </div>
            )
          ) : (
            !explained && (
              <EmptyState compact heading={3} icon="code" title="Write a query and Run">
                Click a dataset or a column on the left to insert its name. The first 500 rows show here; Save as dataset keeps them all.
              </EmptyState>
            )
          )}
        </section>
      </div>
    </div>
  );
}

export default function QueryPage() {
  const { projectId } = useParams();
  useAdoptProject(projectId);
  if (!projectId) return <PageSkeleton />;
  return (
    <div className={`${a.wb} ${s.page}`}>
      <Head projectId={projectId} />
      <div className={s.wrap}>
        <Workbench projectId={projectId} />
      </div>
    </div>
  );
}
