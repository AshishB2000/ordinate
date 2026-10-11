// "Find similar values" — inside the Replace step's form, for an exact match on
// a text column. The SERVER decides which values look like one thing written
// differently and counts the rows (prepare:similarValues, over the input this
// step will get); this lists its groups to tick and turns the ticked ones into
// ordinary find → replace rules in the form. Nothing is saved here: the rules
// are the user's to edit, and the step is theirs to save or remove.
//
// "Ask the Assistant too" adds the model's pass for aliases a spelling rule
// cannot see (US / United States). It only names groups of the column's own
// values; the value the others become and every count are still the server's.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { similarValues, type SimilarReply, type ValueCluster } from './api';
import { fmtN } from './steps';
import s from './Prepare.module.css';

type Found = Extract<SimilarReply, { ok: true }>;
type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; text: string } | { kind: 'found'; reply: Found; asked: boolean; off: ReadonlySet<string> };

const NOT_READY = 'The Assistant is not connected yet — connect a model from the Assistant panel (⌘J).';
const plural = (n: number, one: string, many: string): string => `${fmtN(n)} ${n === 1 ? one : many}`;

function detail(c: ValueCluster): string {
  return `${c.from.map((m) => `"${m.value}" (${fmtN(m.count)})`).join(', ')} · ${plural(c.rows, 'row changes', 'rows change')}`;
}

export function SimilarValues({
  projectId,
  datasetId,
  index,
  column,
  onAdd,
}: {
  projectId: string;
  datasetId: string;
  index: number;
  column: string;
  onAdd: (rules: Array<{ from: string; to: string }>) => void;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function find(assistant: boolean) {
    setState({ kind: 'busy' });
    const r = await similarValues(projectId, datasetId, index, column, assistant).catch(() => null);
    if (r && r.ok) setState({ kind: 'found', reply: r, asked: assistant, off: new Set() });
    else setState({ kind: 'error', text: (r && r.error) || 'Could not compare the values.' });
  }

  if (state.kind === 'idle' || state.kind === 'error') {
    return (
      <div className={s.similarAsk}>
        <div className={s.actions}>
          <Button size="sm" icon="search" onClick={() => void find(false)}>
            Find similar values
          </Button>
        </div>
        {state.kind === 'error' ? (
          <p className={s.problem} role="alert">{state.text}</p>
        ) : (
          <p className={s.hint}>Looks for values that are the same thing written differently — case, punctuation, “Inc.” and “LLC” — and offers them as rules.</p>
        )}
      </div>
    );
  }
  if (state.kind === 'busy') {
    return (
      <section className={s.suggest} aria-label="Similar values" aria-busy="true">
        <p className={s.muted}>Comparing the values of “{column}”…</p>
      </section>
    );
  }

  const { reply, asked, off } = state;
  const picked = reply.clusters.filter((c) => !off.has(c.to));
  const toggle = (to: string, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(to);
    else next.add(to);
    setState({ ...state, off: next });
  };
  const note = reply.assistant ? (reply.assistant.notReady ? NOT_READY : reply.assistant.error || 'The Assistant could not answer.') : null;

  return (
    <section className={s.suggest} aria-label="Similar values">
      <p className={s.aiHead}>
        {reply.clusters.length
          ? `${plural(reply.clusters.length, 'group', 'groups')} of similar values in “${column}” — nothing changes until you add them as rules and save the step.`
          : `No similar values among the ${plural(reply.distinct, 'value', 'values')} of “${column}”.`}
      </p>
      {reply.clusters.length > 0 && (
        <ul className={s.similarList}>
          {reply.clusters.map((c) => (
            <li key={c.to}>
              <Checkbox
                label={`Merge ${fmtN(c.from.length + 1)} variations into “${c.to}”`}
                hint={detail(c)}
                checked={!off.has(c.to)}
                onCheckedChange={(on) => toggle(c.to, on)}
              />
            </li>
          ))}
        </ul>
      )}
      {reply.more > 0 && <p className={s.muted}>{plural(reply.more, 'more group', 'more groups')} — add these, save the step, and look again.</p>}
      {note && <p className={s.muted}>{note}</p>}
      <div className={s.actions}>
        {reply.clusters.length > 0 && (
          <Button
            variant="primary"
            size="sm"
            disabled={!picked.length}
            onClick={() => {
              onAdd(picked.flatMap((c) => c.from.map((m) => ({ from: m.value, to: c.to }))));
              setState({ kind: 'idle' });
            }}
          >
            {picked.length === 1 ? 'Add 1 merge as rules' : `Add ${fmtN(picked.length)} merges as rules`}
          </Button>
        )}
        {!asked && (
          <Button size="sm" icon="sparkles" onClick={() => void find(true)}>
            Ask the Assistant too
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setState({ kind: 'idle' })}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
