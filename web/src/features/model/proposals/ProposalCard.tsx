// One proposal, as an editor reviews it (docs/metric-proposals/00-design.md, "The review queue"): the definition, a live
// preview computed by the server for THEM (their access, the engine's figure), how many people needed it and the
// questions they asked (never an answer), and Approve, Edit and Decline. Approval is the normal save; the server checks the
// draft again as the approving editor. Nothing here computes a figure.

import { useState } from 'react';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { definitionOf, useDecide, usePreview, type Proposal } from './api';
import s from './Proposals.module.css';

const needed = (n: number): string => (n === 1 ? 'Needed once' : `Needed ${n} times`);

function Preview({ projectId, p, formula }: { projectId: string; p: Proposal; formula: string | undefined }) {
  const q = usePreview(projectId, p, formula, p.state === 'open');
  if (p.problem) return null;
  return (
    <div className={s.preview} aria-live="polite">
      <span className={s.previewLabel}>{p.kind === 'term' ? 'Rows it matches, counted for you now' : 'Live preview, computed for you now'}</span>
      {q.isPending ? <Skeleton className={s.figure} /> : q.data?.ok ? <span className={s.figure} data-testid="proposal-figure">{q.data.display}</span> : <p className={s.problem}>{q.data?.error ?? 'No figure could be computed.'}</p>}
    </div>
  );
}

export function ProposalCard({ projectId, p }: { projectId: string; p: Proposal }) {
  const { approve, decline } = useDecide(projectId);
  const [mode, setMode] = useState<'view' | 'edit' | 'decline'>('view');
  const [name, setName] = useState(p.name);
  const [words, setWords] = useState(p.description);
  const [aliases, setAliases] = useState(p.aliases.join(', '));
  const [formula, setFormula] = useState(p.formula ?? '');
  const [shown, setShown] = useState(p.formula); // the formula the preview is of: the last one the editor left the box with
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const open = p.state === 'open';
  const busy = approve.isPending || decline.isPending;

  const edit = () => {
    const out: { name?: string; description?: string; aliases?: string[]; formula?: string } = {};
    if (name.trim() !== p.name) out.name = name.trim();
    if (words.trim() !== p.description) out.description = words.trim();
    const list = aliases.split(',').map((a) => a.trim()).filter(Boolean);
    if (list.join('\n') !== p.aliases.join('\n')) out.aliases = list;
    if (p.formula !== undefined && formula.trim() !== p.formula) out.formula = formula.trim();
    return Object.keys(out).length ? out : undefined;
  };
  async function onApprove(): Promise<void> {
    setError('');
    const r = await approve.mutateAsync({ id: p.id, ...(mode === 'edit' && edit() ? { edit: edit() } : {}) }).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'Could not approve.' }));
    if (r.ok) toast(`${p.name} is saved. The people who asked are told.`);
    else setError(r.error || 'Could not approve.');
  }
  async function onDecline(): Promise<void> {
    setError('');
    const r = await decline.mutateAsync({ id: p.id, note: note.trim() }).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'Could not decline.' }));
    if (!r.ok) setError(r.error || 'Could not decline.');
  }

  return (
    <li className={s.card} data-state={p.state} data-testid="proposal-card" aria-label={`${p.kind === 'term' ? 'Term' : 'Metric'} proposal: ${p.name}`}>
      <div className={s.main}>
        <div className={s.head}>
          <Badge tone={p.kind === 'term' ? 'neutral' : 'accent'} icon="sparkles">{p.kind === 'term' ? 'New term' : 'New metric'}</Badge>
          {p.state !== 'open' && <Badge tone={p.state === 'approved' ? 'ok' : 'neutral'}>{p.state === 'approved' ? `Approved${p.decidedBy ? ` by ${p.decidedBy}` : ''}${p.edited ? ' with edits' : ''}` : `Declined${p.decidedBy ? ` by ${p.decidedBy}` : ''}`}</Badge>}
          <span className={s.need}>{needed(p.asks)}</span>
        </div>
        <h3 className={s.name}>{p.name}</h3>
        {mode === 'edit' ? (
          <div className={s.form}>
            <label className={s.field}>Name<input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
            {p.formula !== undefined && (
              <label className={s.field}>Formula
                <textarea className={s.mono} value={formula} maxLength={2000} onChange={(e) => setFormula(e.target.value)} onBlur={() => setShown(formula.trim() || p.formula)} />
              </label>
            )}
            <label className={s.field}>Description<textarea value={words} maxLength={500} onChange={(e) => setWords(e.target.value)} /></label>
            <label className={s.field}>Other names, separated by commas<input value={aliases} onChange={(e) => setAliases(e.target.value)} /></label>
          </div>
        ) : (
          <>
            <pre className={s.def}>{definitionOf(p)}</pre>
            <p className={s.on}>on <b>{p.datasetName || 'a dataset'}</b>{p.format ? `, shown as ${p.format}` : ''}</p>
            {p.description && <p className={s.words}>{p.description}</p>}
            {p.aliases.length > 0 && <p className={s.aliases}>Other names: {p.aliases.join(', ')}</p>}
          </>
        )}
        {p.problem && <p className={s.problem} role="alert">{p.problem}</p>}
        {p.state === 'declined' && p.answer && <p className={s.result}>Note: {p.answer}</p>}
      </div>
      <div className={s.side}>
        <Preview projectId={projectId} p={p} formula={mode === 'edit' ? shown : p.formula} />
        <span className={s.qLabel}>Questions that needed it</span>
        <ul className={s.qs}>{p.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        <p className={s.privacy}>Only the question’s words are shown, never the answer or its figures.</p>
        {mode === 'decline' && (
          <div className={s.form}>
            <label className={s.field}>Why not? The people who asked will read this.<textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></label>
          </div>
        )}
        {error && <p className={s.problem} role="alert">{error}</p>}
        {open && (
          <div className={s.actions}>
            {mode === 'decline' ? (
              <>
                <Button variant="danger" loading={decline.isPending} disabled={!note.trim() || busy} onClick={() => void onDecline()}>Decline</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setMode('view')}>Back</Button>
              </>
            ) : (
              <>
                <Button variant="primary" icon="check" loading={approve.isPending} disabled={busy || (!!p.problem && mode !== 'edit')} onClick={() => void onApprove()}>
                  {mode === 'edit' ? 'Approve with edits' : 'Approve'}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}>{mode === 'edit' ? 'Stop editing' : 'Edit'}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setMode('decline')}>Decline</Button>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
