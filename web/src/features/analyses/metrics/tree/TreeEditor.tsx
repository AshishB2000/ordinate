// Edit a metric's tree: each node says how it breaks down — a sum (parts may
// be subtracted), a product, a ratio, or a split by a text column. Suggestions
// read from the project's formulas come first (metricTree:suggest). The draft
// is a TreeSpec; the server sanitizes it again on save (limits, cycles,
// same-dataset parts) and computes everything else.

import { useMemo, useState } from 'react';
import { Button, IconButton } from '../../../../ui/Button';
import { Dialog, DialogClose } from '../../../../ui/Dialog';
import { Select } from '../../../../ui/Select';
import { Skeleton } from '../../../../ui/Skeleton';
import { ErrorState } from '../../../../ui/States';
import { Icon } from '../../../../ui/icons/Icon';
import { saveTree, useSuggest, type Relation, type Suggestion, type SuggestReply, type TreeSpec } from './api';
import s from './TreeEditor.module.css';

type Kind = Relation | 'split';
const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: 'product', label: 'Product', hint: 'A × B — Revenue = Orders × Avg order value' },
  { value: 'sum', label: 'Sum', hint: 'A + B − C — Profit = Revenue − Cost' },
  { value: 'ratio', label: 'Ratio', hint: 'A ÷ B — Margin % = Profit ÷ Revenue' },
  { value: 'split', label: 'Split by a column', hint: 'Each segment’s share of the change' },
];
const LIMITS: Record<Relation, [number, number]> = { sum: [2, 8], product: [2, 4], ratio: [2, 2] };
const MAX_DEPTH = 4;
const OP: Record<Relation, string> = { sum: '+', product: '×', ratio: '÷' };

const uuid = (): string => crypto.randomUUID();

function mapNode(n: TreeSpec, id: string, fn: (n: TreeSpec) => TreeSpec): TreeSpec {
  if (n.id === id) return fn(n);
  return n.children ? { ...n, children: n.children.map((c) => mapNode(c, id, fn)) } : n;
}

/** The node with its breakdown replaced (or removed, with null). */
function withBreakdown(n: TreeSpec, b: Pick<TreeSpec, 'relation' | 'children' | 'split'> | null): TreeSpec {
  const { relation: _r, children: _c, split: _s, ...rest } = n;
  return b ? { ...rest, ...b } : rest;
}

export function describe(n: TreeSpec, name: (id: string) => string): string {
  if (n.split) return `Split by ${n.split}`;
  if (!n.relation || !n.children) return '';
  return n.children.map((c, i) => (i === 0 ? (c.negative ? '−' : '') : n.relation === 'sum' ? (c.negative ? ' − ' : ' + ') : ` ${OP[n.relation as Relation]} `) + name(c.metricId)).join('');
}

function BreakdownForm({
  node,
  blocked,
  data,
  onApply,
  onCancel,
}: {
  node: TreeSpec;
  /** The node's own metric and its ancestors: a part may not repeat one (a cycle). */
  blocked: Set<string>;
  data: SuggestReply;
  onApply: (b: Pick<TreeSpec, 'relation' | 'children' | 'split'>) => void;
  onCancel: () => void;
}) {
  const ideas = (data.suggestions[node.metricId] ?? []).filter((x) => x.children.every((c) => !blocked.has(c.metricId)));
  const [kind, setKind] = useState<Kind>(ideas[0]?.relation ?? 'product');
  const [parts, setParts] = useState<{ metricId: string; negative?: boolean }[]>([{ metricId: '' }, { metricId: '' }]);
  const [column, setColumn] = useState('');
  const options = data.metrics.filter((m) => !blocked.has(m.id)).map((m) => ({ value: m.id, label: m.name }));
  const apply = (x: Suggestion) => onApply({ relation: x.relation, children: x.children.map((c) => ({ id: uuid(), metricId: c.metricId, ...(c.negative ? { negative: true as const } : {}) })) });
  const rel = kind === 'split' ? null : kind;
  const shown = rel === 'ratio' ? parts.slice(0, 2) : parts;
  const chosen = shown.map((p) => p.metricId).filter(Boolean);
  const valid = kind === 'split' ? !!column : !!rel && chosen.length === shown.length && new Set(chosen).size === chosen.length && chosen.length >= LIMITS[rel][0];

  const name = (id: string) => data.metrics.find((m) => m.id === id)?.name ?? '—';
  return (
    <div className={s.form}>
      {ideas.length > 0 && (
        <div className={s.ideas}>
          <span className={s.formLabel}>
            <Icon name="sparkles" size={12} /> From your formulas
          </span>
          {ideas.map((x, i) => (
            <button key={i} type="button" className={s.idea} onClick={() => apply(x)}>
              <span className={s.ideaText}>{describe({ id: '', metricId: '', relation: x.relation, children: x.children.map((c) => ({ id: '', ...c })) }, name)}</span>
              <span className={s.ideaFrom}>from {x.from}</span>
            </button>
          ))}
        </div>
      )}
      <div className={s.kinds} role="radiogroup" aria-label="Break it down as">
        {KINDS.map((k) => (
          <button key={k.value} type="button" role="radio" aria-checked={kind === k.value} className={s.kind} onClick={() => setKind(k.value)}>
            <span className={s.kindName}>{k.label}</span>
            <span className={s.kindHint}>{k.hint}</span>
          </button>
        ))}
      </div>
      {kind === 'split' ? (
        <Select
          label="Column"
          value={column || null}
          placeholder={data.columns.length ? 'Pick a text column' : 'This dataset has no text column'}
          disabled={!data.columns.length}
          options={data.columns.map((c) => ({ value: c, label: c }))}
          onValueChange={setColumn}
        />
      ) : (
        <div className={s.parts}>
          {shown.map((p, i) => (
            <div key={i} className={s.part}>
              {rel === 'sum' ? (
                <button
                  type="button"
                  className={s.sign}
                  aria-label={p.negative ? `Part ${i + 1} is subtracted — add it instead` : `Part ${i + 1} is added — subtract it instead`}
                  aria-pressed={!!p.negative}
                  onClick={() => setParts(parts.map((q, j) => (j === i ? { ...q, negative: !q.negative } : q)))}
                >
                  {p.negative ? '−' : '+'}
                </button>
              ) : (
                <span className={s.op} aria-hidden="true">
                  {i === 0 ? '=' : OP[rel as Relation]}
                </span>
              )}
              <Select
                aria-label={rel === 'ratio' ? (i === 0 ? 'Numerator' : 'Denominator') : `Part ${i + 1}`}
                value={p.metricId || null}
                placeholder={rel === 'ratio' ? (i === 0 ? 'Numerator…' : 'Denominator…') : 'Pick a metric…'}
                options={options.map((o) => ({ ...o, disabled: o.value !== p.metricId && chosen.includes(o.value) }))}
                onValueChange={(v) => setParts(parts.map((q, j) => (j === i ? { ...q, metricId: v } : q)))}
                className={s.partSelect}
              />
              {rel !== 'ratio' && shown.length > 2 && <IconButton icon="x" size="sm" label={`Remove part ${i + 1}`} onClick={() => setParts(parts.filter((_, j) => j !== i))} />}
            </div>
          ))}
          {rel !== 'ratio' && rel && parts.length < LIMITS[rel][1] && (
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setParts([...parts, { metricId: '' }])}>
              Add a part
            </Button>
          )}
          {options.length < 2 && <p className={s.hint}>A part is a saved metric on the same dataset. Define the parts on the Metrics page first.</p>}
        </div>
      )}
      <div className={s.formFoot}>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!valid}
          onClick={() =>
            onApply(
              kind === 'split'
                ? { split: column }
                : { relation: rel as Relation, children: shown.map((p) => ({ id: uuid(), metricId: p.metricId, ...(rel === 'sum' && p.negative ? { negative: true as const } : {}) })) },
            )
          }
        >
          Break it down
        </Button>
      </div>
    </div>
  );
}

function Row({
  node,
  depth,
  path,
  data,
  editing,
  setEditing,
  onChange,
}: {
  node: TreeSpec;
  depth: number;
  path: string[];
  data: SuggestReply;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onChange: (id: string, fn: (n: TreeSpec) => TreeSpec) => void;
}) {
  const name = (id: string) => data.metrics.find((m) => m.id === id)?.name ?? 'A deleted metric';
  const broken = !!node.split || !!node.relation;
  const blocked = new Set([...path, node.metricId]);
  return (
    <li className={s.item}>
      <div className={depth === 0 ? `${s.row} ${s.rootRow}` : s.row}>
        <span className={s.rowName}>{name(node.metricId)}</span>
        {broken ? (
          <span className={s.chip}>
            <Icon name={node.split ? 'layers' : 'function'} size={12} />
            {node.split ? `by ${node.split}` : `= ${describe(node, name)}`}
          </span>
        ) : (
          <span className={s.leaf}>Not broken down</span>
        )}
        <span className={s.rowActions}>
          {broken ? (
            <Button size="sm" variant="ghost" icon="x" onClick={() => onChange(node.id, (n) => withBreakdown(n, null))} aria-label={`Remove the breakdown of ${name(node.metricId)}`}>
              Remove
            </Button>
          ) : depth < MAX_DEPTH ? (
            <Button size="sm" icon="plus" onClick={() => setEditing(editing === node.id ? null : node.id)} aria-expanded={editing === node.id}>
              Break down…
            </Button>
          ) : null}
        </span>
      </div>
      {editing === node.id && !broken && (
        <BreakdownForm
          node={node}
          blocked={blocked}
          data={data}
          onCancel={() => setEditing(null)}
          onApply={(b) => {
            onChange(node.id, (n) => withBreakdown(n, b));
            setEditing(null);
          }}
        />
      )}
      {node.children && node.children.length > 0 && (
        <ul className={s.list}>
          {node.children.map((c) => (
            <Row key={c.id} node={c} depth={depth + 1} path={[...blocked]} data={data} editing={editing} setEditing={setEditing} onChange={onChange} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TreeEditor({
  projectId,
  metricId,
  metricName,
  initial,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  metricId: string;
  metricName: string;
  initial: TreeSpec | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const q = useSuggest(projectId, metricId);
  const start = useMemo<TreeSpec>(() => initial ?? { id: uuid(), metricId }, [initial, metricId]);
  const [draft, setDraft] = useState<TreeSpec>(start);
  const [editing, setEditing] = useState<string | null>(initial ? null : start.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    const broken = !!draft.relation || !!draft.split;
    const err = await saveTree(projectId, metricId, broken ? draft : null);
    setBusy(false);
    if (err) return setError(err);
    onSaved();
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Break down ${metricName}`}
      description="Each part is a saved metric on the same dataset. Ordinate weighs how much each part moved the total — the figures are always the app’s."
      footer={
        <>
          {error && (
            <span className={s.error} role="alert">
              {error}
            </span>
          )}
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={busy} disabled={!q.isSuccess} onClick={() => void save()}>
            Save tree
          </Button>
        </>
      }
    >
      {q.isPending ? (
        <div className={s.loading} aria-busy="true" aria-label="Loading the metrics">
          <Skeleton className={s.skRow} />
          <Skeleton className={s.skRow} />
          <Skeleton className={s.skRow} />
        </div>
      ) : q.isError ? (
        <ErrorState compact heading={3} title="The metrics could not be read" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <ul className={`${s.list} ${s.top}`} aria-label={`${metricName}’s tree`}>
          <Row node={draft} depth={0} path={[]} data={q.data} editing={editing} setEditing={setEditing} onChange={(id, fn) => setDraft((d) => mapNode(d, id, fn))} />
        </ul>
      )}
    </Dialog>
  );
}
