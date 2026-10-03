// /data/input/:projectId/:datasetId — an INPUT TABLE's editable grid (legacy
// inputPage.ts / inputGrid.ts / inputKeys.ts / inputBind.ts) on the DataGrid's
// editable mode.
//
// Every change is a BATCH from the shared edit model — src/data/inputTable/
// edits.ts, the same module the server replays saved batches with, so the grid
// and the stored table cannot disagree about what a paste or a fill does:
//
//   · applied here at once and pushed on the undo stack (one action, one step);
//   · SAVED shortly after (input:save, debounced) — the desktop saved on blur,
//     but a browser tab can close without a reliable last request, so the web
//     saves as you go; the server replays, validates, writes once and records
//     one version per batch;
//   · CHECKED by the server: the save's reply carries the check (type,
//     required, lookup, quality rules), and flagged cells get a corner mark
//     with the reason. The browser never decides what is valid.

import { useEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useParams } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { formatNumber } from '../../../../src/app/format.ts';
import * as edits from '../../../../src/data/inputTable/edits.ts';
import { rpc } from '../../api/client';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { DataGrid, type CellFlag, type GridRange } from '../../ui/DataGrid/DataGrid';
import { Kbd } from '../../ui/Kbd';
import { toast } from '../../ui/Toast';
import { type TableReply, type TableView } from './api';
import { InputColumnsDialog } from './InputColumnsDialog';
import { InputToolbar } from './InputToolbar';
import s from './Import.module.css';

const SAVE_MS = 500;
const ORIGIN: GridRange = { r0: 0, c0: 0, r1: 0, c1: 0 };

/** The editor's working copy: main's table, plus what was typed since. */
export interface Model {
  view: TableView;
  rows: edits.Cell[][];
  hist: edits.History;
  pending: edits.Batch[];
  saving: boolean;
  error: string;
}

const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

function Editor({ projectId, initial }: { projectId: string; initial: TableView }) {
  const m = useRef<Model>({ view: initial, rows: initial.rows, hist: edits.histNew(), pending: [], saving: false, error: '' }).current;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [sel, setSel] = useState<GridRange>(ORIGIN);
  const [editing, setEditing] = useState(false);
  const timer = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const id = m.view.id;
  const cols = m.view.columns;
  const width = cols.length;
  const cap = m.view.cap;

  /** Take the server's copy (after a save or a column change); its rows only when nothing newer is queued. */
  const adopt = (v: TableView, rowsToo: boolean) => {
    m.view = v;
    if (rowsToo) m.rows = v.rows;
  };
  const saveNow = async () => {
    if (!m.pending.length) return;
    const batches = m.pending.splice(0);
    m.saving = true;
    m.error = '';
    bump();
    let r: TableReply;
    try {
      r = (await rpc('input:save', { projectId, id, batches })) as TableReply;
    } catch (err) {
      r = { ok: false, error: err instanceof Error ? err.message : 'The table could not be saved.' };
    }
    m.saving = false;
    if (!r.ok) {
      m.pending.unshift(...batches); // nothing was written: keep them, and say so
      m.error = r.error;
    } else {
      adopt(r, m.pending.length === 0);
    }
    bump();
  };
  const flush = () => {
    window.clearTimeout(timer.current);
    chain.current = chain.current.then(saveNow).catch(() => undefined);
    return chain.current;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const away = () => void flushRef.current();
    const hidden = () => document.hidden && away();
    window.addEventListener('pagehide', away);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', away);
      document.removeEventListener('visibilitychange', hidden);
      away(); // leaving the page saves what is queued
    };
  }, []);

  const commit = (batch: edits.Batch | null, select?: GridRange): boolean => {
    if (!batch) return false;
    const res = edits.applyBatch(m.rows, batch, width, cap);
    if (!res) return false;
    m.rows = res.rows;
    edits.histPush(m.hist, { label: batch.label, forward: batch, inverse: res.inverse });
    m.pending.push(batch);
    if (select) setSel(select);
    bump();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_MS);
    return true;
  };
  const step = (dir: 'undo' | 'redo') => {
    const e = dir === 'undo' ? edits.histUndo(m.hist) : edits.histRedo(m.hist);
    if (!e) return;
    const b = dir === 'undo' ? e.inverse : e.forward;
    const res = edits.applyBatch(m.rows, b, width, cap);
    if (!res) return void toast('That step no longer fits the table.', { kind: 'error' });
    m.rows = res.rows;
    // Undoing a batch still waiting to be saved simply drops it from the queue.
    const other = dir === 'undo' ? e.forward : e.inverse;
    if (m.pending[m.pending.length - 1] === other) m.pending.pop();
    else m.pending.push(b);
    const last = Math.max(0, m.rows.length - 1);
    if (sel.r1 > last + 1) setSel({ r0: last, c0: sel.c1, r1: last, c1: sel.c1 });
    bump();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_MS);
    toast(`${dir === 'undo' ? 'Undid' : 'Redid'} ${e.label.charAt(0).toLowerCase()}${e.label.slice(1)}`);
  };

  // The grid's rows: the working copy plus the trailing new-row line (typing there appends).
  const rows = m.rows;
  const ghost = rows.length < cap;
  const source = useMemo(() => {
    const total = rows.length + (ghost ? 1 : 0);
    return async (o: number, l: number) => ({
      rows: Array.from({ length: Math.max(0, Math.min(l, total - o)) }, (_, k) => rows[o + k] ?? new Array<edits.Cell>(width).fill(null)),
      total,
    });
  }, [rows, ghost, width]);
  const issues = m.view.check.issues;
  const flags = useMemo(() => {
    const at = new Map<string, CellFlag>();
    for (const i of issues) {
      const k = `${i.r}:${i.c}`;
      const prev = at.get(k);
      const text = i.message || 'This value needs attention.';
      at.set(k, { tone: prev?.tone === 'bad' || i.severity === 'fail' ? 'bad' : 'warn', text: prev ? `${prev.text}\n${text}` : text });
    }
    return at;
  }, [issues]);
  const cellFlag = useMemo(() => (r: number, c: number) => flags.get(`${r}:${c}`), [flags]);

  // The lookup columns' values, as the editor's suggestions (≤ 200 each, searched in SQL by the server).
  const lookups = cols.map((c, i) => ({ c, i })).filter((x) => x.c.lookup);
  const lists = useQueries({
    queries: lookups.map(({ c }) => ({
      queryKey: ['dataset:distinct', projectId, c.lookup?.datasetId, c.lookup?.column],
      queryFn: async () =>
        (await rpc('dataset:distinct', { projectId, datasetId: c.lookup?.datasetId ?? '', column: c.lookup?.column ?? '', limit: 200 })) as { values: string[]; total: number },
    })),
  });
  const listId = (col: number) => (cols[col]?.lookup ? `it-lookup-${col}` : undefined);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).getAttribute('role') !== 'grid') return; // the cell editor keeps its keys
    const k = e.key.toLowerCase();
    let done = true;
    if (isMod(e) && !e.altKey && k === 'z') step(e.shiftKey ? 'redo' : 'undo');
    else if (isMod(e) && !e.altKey && k === 'y') step('redo');
    else if (isMod(e) && !e.altKey && !e.shiftKey && k === 'd') {
      if (!commit(edits.fillDownBatch(rows, sel))) toast('Select the cells to fill — the first row of the selection is copied down.');
    } else if (isMod(e) && !e.altKey && !e.shiftKey && k === 'a') setSel({ r0: 0, c0: 0, r1: Math.max(0, rows.length - 1), c1: width - 1 });
    else if (!isMod(e) && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) commit(edits.clearBatch(rows, sel));
    else done = false;
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const onClip = (e: ClipboardEvent<HTMLDivElement>, kind: 'copy' | 'cut' | 'paste') => {
    if ((e.target as HTMLElement).getAttribute('role') !== 'grid') return;
    e.preventDefault();
    if (kind === 'paste') {
      const text = e.clipboardData.getData('text/plain');
      const plan = edits.pasteBatch(text, sel, rows.length, width, cap);
      if (!plan) {
        if (text && rows.length >= cap) toast(`The table is at its row limit (${formatNumber(cap)}).`, { kind: 'error' });
        return;
      }
      const p = plan.range;
      commit(plan.batch, { r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1 });
      if (plan.clipped) toast(`${formatNumber(plan.clipped)} pasted cell${plan.clipped === 1 ? '' : 's'} did not fit past the last column or the ${formatNumber(cap)}-row limit.`);
      return;
    }
    const a = Math.min(sel.r0, sel.r1);
    const b = Math.min(Math.max(sel.r0, sel.r1), rows.length - 1);
    if (b < a) return;
    const c0 = Math.min(sel.c0, sel.c1);
    const c1 = Math.max(sel.c0, sel.c1);
    e.clipboardData.setData('text/plain', edits.toTsv(rows.slice(a, b + 1).map((r) => r.slice(c0, c1 + 1))));
    if (kind === 'cut') commit(edits.clearBatch(rows, sel));
  };

  const notes = [...m.view.check.notes, ...(m.view.steps ? [`Prepare has ${m.view.steps} step${m.view.steps === 1 ? '' : 's'} on this table — the dataset page shows their output.`] : [])];
  return (
    <Page title={m.view.name} sub="Input table — type or paste rows; every change is saved and checked by the server.">
      <div className={s.inputHost}>
        <InputToolbar
          m={m}
          sel={sel}
          onAddRow={() => {
            const at = rows.length;
            if (!commit(edits.insertRowsBatch(at, 1, at, cap), { r0: at, c0: 0, r1: at, c1: 0 })) toast(`An input table holds up to ${formatNumber(cap)} rows.`, { kind: 'error' });
          }}
          onDeleteRows={() => commit(edits.deleteRowsBatch(sel.r0, sel.r1, rows.length), { r0: Math.min(sel.r0, sel.r1), c0: sel.c1, r1: Math.min(sel.r0, sel.r1), c1: sel.c1 })}
          onUndo={() => step('undo')}
          onRedo={() => step('redo')}
          onEditColumns={() =>
            void flush().then(() => {
              if (m.pending.length || m.error) return toast(`Save the table first — ${m.error || 'edits are still being saved'}.`, { kind: 'error' });
              setEditing(true);
            })
          }
          onRetry={() => void flush()}
          onNextIssue={() => {
            const keys = issues.map((i) => i.r * width + i.c).sort((x, y) => x - y);
            const here = sel.r1 * width + sel.c1;
            const next = keys.find((k) => k > here) ?? keys[0];
            if (next === undefined) return;
            const r = Math.floor(next / width);
            const c = next % width;
            setSel({ r0: r, c0: c, r1: r, c1: c });
          }}
        />
        {notes.length > 0 && (
          <div className={s.inputNotes} role="note">
            {notes.map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </div>
        )}
        {rows.length === 0 && <p className={s.hint}>No rows yet — type into the first row, or paste cells from a spreadsheet.</p>}
        <div className={s.inputGrid} onKeyDownCapture={onKey} onCopy={(e) => onClip(e, 'copy')} onCut={(e) => onClip(e, 'cut')} onPaste={(e) => onClip(e, 'paste')}>
          <DataGrid
            columns={cols}
            source={source}
            label={`${m.view.name}, editable`}
            editable
            onEdit={(e) => commit(edits.editBatch(rows, e.row, e.column, e.value, cols[e.column]?.name ?? '', cap))}
            selection={sel}
            onSelectionChange={setSel}
            cellFlag={cellFlag}
            editorList={listId}
          />
        </div>
        {lookups.map(({ i }, k) => (
          <datalist key={i} id={listId(i)}>
            {(lists[k]?.data?.values ?? []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        ))}
        <div className={s.inputFoot}>
          <p className={s.keysHint}>
            <span><Kbd>Enter</Kbd> edit</span>
            <span><Kbd>Shift</Kbd>+arrows select</span>
            <span><Kbd>⌘D</Kbd> fill down</span>
            <span><Kbd>⌘C</Kbd> <Kbd>⌘V</Kbd> copy and paste</span>
            <span><Kbd>Delete</Kbd> clear</span>
            <span><Kbd>⌘Z</Kbd> undo</span>
          </p>
          <span className={s.count}>
            {formatNumber(rows.length)} of {formatNumber(cap)} rows
          </span>
        </div>
      </div>
      {editing && (
        <InputColumnsDialog
          projectId={projectId}
          mode="edit"
          datasetId={id}
          columns={cols}
          onClose={() => setEditing(false)}
          onDone={(_id, v) => {
            setEditing(false);
            if (!v) return;
            adopt(v, true);
            m.hist = edits.histNew(); // cell positions moved with the columns
            setSel(ORIGIN);
            bump();
            toast('Columns saved. The previous layout is in the table’s history.', { kind: 'success' });
          }}
        />
      )}
    </Page>
  );
}

export default function InputTablePage() {
  const { projectId = '', datasetId = '' } = useParams();
  const q = useQuery({
    queryKey: ['input:load', projectId, datasetId],
    queryFn: async () => (await rpc('input:load', { projectId, id: datasetId })) as TableReply,
    staleTime: Infinity, // the editor owns its working copy once open
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <Page title="Input table">
        <ErrorState title="This input table could not be opened" message={q.error.message} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  if (!q.data.ok) {
    return (
      <Page title="Input table">
        <EmptyState icon="table" title="This input table could not be opened" actions={<Link className={buttonClass('secondary')} to={`/data/${projectId}/${datasetId}`}>Open the dataset</Link>}>
          {q.data.error}
        </EmptyState>
      </Page>
    );
  }
  return <Editor key={datasetId} projectId={projectId} initial={q.data} />;
}
