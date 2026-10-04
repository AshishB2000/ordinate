// The Assistant's two Prepare actions (legacy prepare.ts handleSuggestSteps /
// handleSuggestCalcField). The model proposes STRUCTURE only and nothing is
// applied until the user does: suggested steps wait for "Apply steps" (which
// replaces the pipeline, as the desktop does); a suggested calculated field
// opens the formula editor prefilled, so it is seen on real rows first.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { suggestCalc, suggestSteps, type Step } from './api';
import { stepSummary } from './steps';
import s from './Prepare.module.css';

const NOT_READY = 'The Assistant is not connected yet — connect a model from the Assistant panel (⌘J).';

type StepsState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'hint'; text: string } | { kind: 'steps'; steps: Step[] };

/** "Suggest steps with the Assistant": a list to apply or dismiss. */
export function useSuggestSteps(projectId: string, datasetId: string) {
  const [state, setState] = useState<StepsState>({ kind: 'idle' });
  async function ask() {
    setState({ kind: 'busy' });
    const r = await suggestSteps(projectId, datasetId).catch(() => null);
    if (r && r.ok && r.steps.length) setState({ kind: 'steps', steps: r.steps });
    else if (r && r.ok) setState({ kind: 'hint', text: 'No steps suggested — the data already looks ready.' });
    else if (r && r.notReady) setState({ kind: 'hint', text: NOT_READY });
    else setState({ kind: 'hint', text: (r && !r.ok && r.error) || 'Could not get step suggestions.' });
  }
  return { state, ask, dismiss: () => setState({ kind: 'idle' }) };
}

export function SuggestedSteps({
  state,
  names,
  onApply,
  onDismiss,
}: {
  state: StepsState;
  names: ReadonlyMap<string, string>;
  onApply: (steps: Step[]) => void;
  onDismiss: () => void;
}) {
  if (state.kind === 'idle') return null;
  return (
    <section className={s.suggest} aria-label="Suggested steps" aria-busy={state.kind === 'busy' || undefined}>
      <p className={s.aiHead}>Assistant suggestion — structure only; nothing changes until you apply it.</p>
      {state.kind === 'busy' && <p className={s.muted}>Thinking…</p>}
      {state.kind === 'hint' && (
        <p className={s.muted}>{state.text}</p>
      )}
      {state.kind === 'steps' && (
        <>
          <ol className={s.suggestList}>
            {state.steps.map((st, i) => (
              <li key={i}>{stepSummary(st, names)}</li>
            ))}
          </ol>
          <div className={s.actions}>
            <Button variant="primary" size="sm" onClick={() => onApply(state.steps)}>
              Apply steps
            </Button>
            <Button size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </>
      )}
      {state.kind === 'hint' && (
        <div className={s.actions}>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
}

/** "Suggest calculated field": a hint while it thinks or when it cannot, then the editor, prefilled. */
export function useSuggestCalc(projectId: string, datasetId: string, open: (prefill: { name: string; expression: string; note: string }) => void) {
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask() {
    setBusy(true);
    setHint('Thinking…');
    const r = await suggestCalc(projectId, datasetId).catch(() => null);
    setBusy(false);
    if (r && r.ok) {
      setHint(null);
      open({
        name: r.name,
        expression: r.expression,
        note: `Assistant suggestion — review and edit; the app compiles and computes the formula.${r.warning ? ` ${r.warning}` : ''}`,
      });
    } else setHint(r && r.notReady ? NOT_READY : (r && !r.ok && r.error) || 'Could not suggest a calculated field.');
  }
  return { hint, busy, ask, clear: () => setHint(null) };
}
