// The Assistant's plan card — planCard.ts, ported: "import sales.csv, clean
// it, and build me a regional dashboard" as numbered steps the user runs.
//
// The server owns every decision (src/ipc/plan.ts): the steps were checked
// before this card shows, each is checked again right before it runs, and every
// figure under a step — rows before and after, a KPI — is the app's. Nothing
// runs without a click: Run all, Step through, Fix, Skip, Stop, Undo.
//
// An IMPORT step reads a file: on the desktop through the native picker, here
// through an upload (T0.4) — the card asks for the file and hands its token to
// `plan:next`. A finished, stopped or undone run is logged to the conversation
// by the server; `onLogged` re-reads it.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { rpc, upload } from '../../api/client';
import { Button } from '../../ui/Button';
import { Icon, ICON_NAMES, type IconName } from '../../ui/icons/Icon';
import { EditControls, EditFields, type Step } from './PlanEdit';
import s from './Plan.module.css';

type Status = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
interface Line { text: string; icon: string }
interface Check { ok: boolean; error?: string; deferred?: string }
interface Result {
  summary: string;
  link?: { type: string; id: string; name: string };
  kpis?: { name: string; display: string }[];
}
interface Snap {
  ok: boolean;
  error?: string;
  runId: string;
  state: 'ready' | 'running' | 'paused' | 'failed' | 'finished' | 'stopped' | 'undone';
  steps: Step[];
  lines: Line[];
  status: Status[];
  results: (Result | null)[];
  errors: (string | null)[];
  next: number;
  canUndo: boolean;
  undo: { undone: number; failed: unknown[] } | null;
  log?: string;
}
interface Checked { ok: boolean; error?: string; steps: Step[]; dropped: number; lines: Line[]; checks: Check[] }

const STATUS_TEXT: Record<Status, string> = { pending: 'Pending', running: 'Running…', done: 'Done', skipped: 'Skipped', failed: 'Failed' };
const iconOf = (name: string | undefined): IconName => ((ICON_NAMES as string[]).includes(name ?? '') ? (name as IconName) : 'circle');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface PlanAction {
  intent: string;
  steps: unknown[];
  droppedSteps?: number;
}

export function PlanCard({ projectId, threadId, action, onDone, onLogged }: {
  projectId: string;
  threadId: string;
  action: PlanAction;
  onDone: () => void;
  onLogged: () => void;
}) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [dropped, setDropped] = useState(0);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState<'checking' | 'ok' | 'empty'>('checking');
  const stopAsked = useRef(false);
  const [stopping, setStopping] = useState(false);
  const all = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Silent when nothing survives the check: a proposal is a bonus, never an error.
  useEffect(() => {
    let live = true;
    void (rpc('plan:check', { projectId, steps: action.steps as Step[] }) as Promise<Checked>).then(
      (r) => {
        if (!live) return;
        if (!r.ok || !r.steps.length) return setChecked('empty');
        setSteps(r.steps);
        setLines(r.lines);
        setChecks(r.checks);
        setDropped(r.dropped + (action.droppedSteps ?? 0));
        setChecked('ok');
      },
      () => live && setChecked('empty'),
    );
    return () => {
      live = false;
    };
  }, [projectId, action]);

  useEffect(() => {
    if (checked === 'empty') onDone();
  }, [checked, onDone]);

  /** Take a snapshot from the server: redraw, and re-read the conversation once the run is logged. */
  function apply(r: Snap | { ok: false; error?: string; runId?: string }): Snap | null {
    if (!r.ok) {
      setNote(r.error || 'That did not work.');
      if ('state' in r) setSnap(r as Snap);
      return 'state' in r ? (r as Snap) : null;
    }
    const sn = r as Snap;
    setSnap(sn);
    setSteps(sn.steps);
    setNote('');
    if (sn.log) onLogged();
    return sn;
  }

  async function call(fn: () => Promise<unknown>): Promise<Snap | null> {
    setBusy(true);
    try {
      return apply((await fn()) as Snap);
    } catch {
      return apply({ ok: false, error: 'That did not work.' });
    } finally {
      setBusy(false);
    }
  }

  /** The next step reads a file the user has not chosen yet (server: uploads only). */
  const needsFile = (sn: Snap | null): boolean => !!sn && sn.next >= 0 && sn.steps[sn.next]?.kind === 'import';

  /** Start the run if needed, then run one step — or keep going until it stops, fails, is stopped, or needs a file. */
  async function go(runAll: boolean, fileToken?: string): Promise<void> {
    if (busy) return;
    all.current = runAll;
    stopAsked.current = false;
    setStopping(false);
    let sn = snap;
    if (!sn) {
      setBusy(true);
      let started: Snap | { ok: false; error?: string };
      try {
        started = (await rpc('plan:start', { projectId, threadId, intent: action.intent.slice(0, 400), steps })) as Snap;
      } catch {
        started = { ok: false, error: 'Could not start the plan.' };
      }
      setBusy(false);
      if (!started.ok) return setNote(started.error || 'Could not start the plan.');
      sn = started as Snap;
      setSnap(sn);
    }
    let token = fileToken;
    for (;;) {
      if (needsFile(sn) && !token) {
        setNote(`Choose the file for step ${(sn?.next ?? 0) + 1}.`);
        return;
      }
      const running = sn as Snap;
      if (running.next >= 0) setSnap({ ...running, status: running.status.map((x, i) => (i === running.next ? 'running' : x)) });
      const runId = running.runId;
      const t = token;
      token = undefined;
      sn = await call(() => rpc('plan:next', { runId, ...(t ? { fileToken: t } : {}) }));
      if (!all.current || stopAsked.current || !sn || sn.state !== 'paused') break;
    }
    if (stopAsked.current && sn && sn.state === 'paused') {
      const runId = sn.runId;
      await call(() => rpc('plan:stop', { runId }));
    }
    stopAsked.current = false;
    setStopping(false);
  }

  async function chooseFile(file: File): Promise<void> {
    setBusy(true);
    setNote(`Uploading ${file.name}…`);
    let token: string;
    try {
      token = (await upload(file, file.name)).fileToken;
    } catch (err) {
      setBusy(false);
      return setNote(err instanceof Error ? err.message : 'The file could not be uploaded.');
    }
    setBusy(false);
    setNote('');
    await go(all.current, token);
  }

  async function recheck(): Promise<void> {
    setBusy(true);
    let r: Checked | null = null;
    try {
      r = (await rpc('plan:check', { projectId, steps })) as Checked;
    } catch {
      r = null;
    }
    setBusy(false);
    if (!r || !r.ok) return setNote((r && r.error) || 'Could not check the edited plan.');
    setSteps(r.steps);
    setChecks(r.checks);
    setLines(r.lines);
    setEditing(false);
    setNote(r.checks.some((c) => c && !c.ok) ? '' : 'Checked — every step passes.');
  }

  function move(i: number, to: number): void {
    const swap = <T,>(a: T[]): T[] => {
      const b = [...a];
      [b[i], b[to]] = [b[to], b[i]];
      return b;
    };
    setSteps(swap(steps));
    setChecks(swap(checks));
    setLines(swap(lines));
  }
  function remove(i: number): void {
    setSteps(steps.filter((_, k) => k !== i));
    setChecks(checks.filter((_, k) => k !== i));
    setLines(lines.filter((_, k) => k !== i));
  }

  const shownLines = snap ? snap.lines : lines;
  const statusOf = (i: number): Status => (snap ? snap.status[i] : 'pending');
  const invalid = snap ? 0 : checks.filter((c) => c && !c.ok).length;
  const state = snap ? snap.state : 'ready';

  function actions() {
    if (busy && snap) {
      return (
        <Button size="sm" disabled={stopping} onClick={() => { stopAsked.current = true; setStopping(true); }}>
          {stopping ? 'Stopping after this step…' : 'Stop after this step'}
        </Button>
      );
    }
    if (!snap) {
      if (editing) return <Button size="sm" variant="primary" loading={busy} onClick={() => void recheck()}>Done editing</Button>;
      return (
        <>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void go(true)}>Run all</Button>
          <Button size="sm" disabled={busy} onClick={() => void go(false)}>Step through</Button>
          <Button size="sm" disabled={busy} onClick={() => { setEditing(true); setNote(''); }}>Edit</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
        </>
      );
    }
    const runId = snap.runId;
    const fileStep = needsFile(snap) && (state === 'paused' || state === 'ready' || state === 'failed');
    if (state === 'failed') {
      const i = snap.next;
      return (
        <>
          <Button size="sm" variant="primary" onClick={() => void fix(i)}>Fix</Button>
          <Button size="sm" onClick={() => void skip(i)}>Skip</Button>
          <Button size="sm" variant="ghost" onClick={() => void call(() => rpc('plan:stop', { runId }))}>Stop</Button>
          {fileStep && <Button size="sm" icon="upload" onClick={() => fileRef.current?.click()}>Choose file…</Button>}
        </>
      );
    }
    if (state === 'paused' || state === 'ready') {
      return (
        <>
          {fileStep ? (
            <Button size="sm" variant="primary" icon="upload" onClick={() => fileRef.current?.click()}>
              {`Choose ${String(snap.steps[snap.next]?.file || 'the file')}…`}
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void go(false)}>{`Run step ${snap.next + 1}`}</Button>
          )}
          <Button size="sm" onClick={() => void go(true)}>Run the rest</Button>
          <Button size="sm" onClick={() => void call(() => rpc('plan:skip', { runId, index: snap.next }))}>Skip it</Button>
          <Button size="sm" variant="ghost" onClick={() => void call(() => rpc('plan:stop', { runId }))}>Stop</Button>
        </>
      );
    }
    const u = snap.undo;
    return (
      <>
        {state === 'undone' && u && (
          <span className={s.hint}>{`Undone — ${plural(u.undone, 'record')} put back${u.failed.length ? `; ${u.failed.length} could not be.` : '.'}`}</span>
        )}
        {state !== 'undone' && snap.canUndo && <Button size="sm" onClick={() => void call(() => rpc('plan:undo', { runId }))}>Undo run</Button>}
        <Button size="sm" variant={state === 'undone' ? 'secondary' : 'primary'} onClick={onDone}>Done</Button>
      </>
    );
  }

  async function skip(i: number): Promise<void> {
    if (!snap) return;
    const runId = snap.runId;
    const sn = await call(() => rpc('plan:skip', { runId, index: i }));
    if (all.current && sn && sn.state === 'paused') await go(true);
  }

  async function fix(i: number): Promise<void> {
    if (!snap) return;
    const runId = snap.runId;
    setNote(`Asking the Assistant to fix step ${i + 1}…`);
    const sn = await call(() => rpc('plan:fix', { runId, index: i }));
    if (sn && sn.ok) setNote(`Step ${i + 1} was rewritten and passed the check — run it when ready.`);
  }

  if (checked !== 'ok') return null;
  return (
    <div className={s.card} data-testid="plan-card">
      <div className={s.cardHead}>
        <span className={s.badge}>AI</span>
        <span className={s.label}>{`Plan — ${plural(steps.length, 'step')}`}</span>
      </div>
      {action.intent && <div className={s.intent}>{action.intent}</div>}
      {dropped > 0 && <div className={`${s.note} ${s.error}`}>{`${plural(dropped, 'part')} of the Assistant's plan were not steps and were left out.`}</div>}
      <ol className={s.steps}>
        {steps.map((step, i) => {
          const st = statusOf(i);
          const check = snap ? null : checks[i];
          const result = snap?.results[i] ?? null;
          const err = snap && st === 'failed' ? snap.errors[i] : null;
          return (
            <li key={i} className={[s.step, s[st], check && !check.ok ? s.invalid : ''].join(' ')}>
              <span className={s.num}>{i + 1}</span>
              <span className={s.ic}>
                <Icon name={iconOf(shownLines[i]?.icon)} />
              </span>
              <div className={s.main}>
                <div className={s.line}>{shownLines[i]?.text || `Step ${i + 1}`}</div>
                {check && !check.ok && <div className={`${s.note} ${s.error}`}>{check.error || 'This step cannot run as it stands.'}</div>}
                {check && check.ok && check.deferred && <div className={s.note}>{check.deferred}</div>}
                {err && <div className={`${s.note} ${s.error}`}>{err}</div>}
                {result && <StepResult r={result} projectId={projectId} />}
                {editing && <EditFields step={step} index={i} onChange={(n) => setSteps(steps.map((x, k) => (k === i ? n : x)))} />}
              </div>
              {editing ? (
                <EditControls index={i} count={steps.length} onMove={(to) => move(i, to)} onRemove={() => remove(i)} />
              ) : (
                <span className={`${s.status} ${s[st]}`}>{STATUS_TEXT[st]}</span>
              )}
            </li>
          );
        })}
      </ol>
      {invalid > 0 && !editing && (
        <div className={s.hint}>{`${plural(invalid, 'step')} will fail as written — Edit, or run and use Fix when it stops.`}</div>
      )}
      {note && <div className={s.hint} role="status">{note}</div>}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".csv,.json,.xlsx"
        aria-label="File to import"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void chooseFile(f);
        }}
      />
      <div className={state === 'failed' ? `${s.actions} ${s.fail}` : s.actions}>{actions()}</div>
    </div>
  );
}

/** What a step did: its summary (or its KPIs, which say the same), and the record it made. */
function StepResult({ r, projectId }: { r: Result; projectId: string }) {
  const kpis = r.kpis ?? [];
  return (
    <div className={s.result}>
      {kpis.length === 0 && <span className={s.resultText}>{r.summary || 'Done'}</span>}
      {kpis.map((k) => (
        <span key={k.name} className={s.kpi}>
          <span className={s.kpiName}>{k.name}</span>
          <span className={s.kpiValue}>{k.display}</span>
        </span>
      ))}
      {r.link &&
        (r.link.type === 'dataset' ? (
          <Link className={s.link} to={`/data/${projectId}/${r.link.id}`}>
            <Icon name="external-link" size={12} />
            {r.link.name || 'Open'}
          </Link>
        ) : (
          // No page for this record yet: its name, unless a KPI chip already says it.
          kpis.length === 0 && <span className={s.linkText}>{r.link.name}</span>
        ))}
    </div>
  );
}
