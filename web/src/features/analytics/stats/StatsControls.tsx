// The workbench's settings column (statsControls.ts) — one set of pickers per
// tab, each writing that tab's spec. Numeric-only pickers list only columns
// DECLARED number: the maths reads the declared type, so offering a text
// column there would only produce an error.

import type { ReactNode } from 'react';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Select } from '../../../ui/Select';
import { fmtCount } from '../format';
import type { GroupsResult, StatsKind, StatsSpec } from '../api';
import s from './Stats.module.css';

type Col = { name: string; type: string };

function Section({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={s.ctl}>
      <div className={s.ctlLabel}>{label}</div>
      {hint && <p className={s.ctlHint}>{hint}</p>}
      {children}
    </div>
  );
}

function None({ children }: { children: ReactNode }) {
  return <p className={s.ctlNone}>{children}</p>;
}

/** A checkbox list with All / None and a running count. `tag` labels each row's kind. */
function Checks({
  name,
  items,
  chosen,
  onChange,
}: {
  name: string;
  items: Array<{ value: string; label: string; tag?: string }>;
  chosen: readonly string[];
  onChange: (v: string[]) => void;
}) {
  const set = new Set(chosen);
  const emit = (next: Set<string>) => onChange(items.map((i) => i.value).filter((v) => next.has(v)));
  return (
    <>
      <div className={s.checkBar}>
        <span className={s.checkCount}>{`${items.filter((i) => set.has(i.value)).length} of ${items.length}`}</span>
        <button type="button" className={s.link} onClick={() => emit(new Set(items.map((i) => i.value)))}>
          All
        </button>
        <button type="button" className={s.link} onClick={() => emit(new Set())}>
          None
        </button>
      </div>
      <div className={s.checks} role="group" aria-label={name}>
        {items.map((it) => (
          <div key={it.value} className={s.check}>
            <Checkbox
              label={it.label}
              checked={set.has(it.value)}
              onCheckedChange={(on) => {
                const next = new Set(set);
                if (on) next.add(it.value);
                else next.delete(it.value);
                emit(next);
              }}
            />
            {it.tag && <span className={s.tag}>{it.tag}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

/** A two-way segmented choice (hub.css .seg). */
export function Seg({ label, options, value, onChange }: { label: string; options: Array<[string, string]>; value: string; onChange: (v: string) => void }) {
  return (
    <div className={s.seg} role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={s.segOpt} aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function StatsControls({
  tab,
  spec,
  columns,
  groups,
  big,
  onChange,
  onRun,
}: {
  tab: StatsKind;
  spec: StatsSpec;
  columns: readonly Col[];
  /** The last Compare-groups reply for this spec's grouping, for its level and success pickers. */
  groups: GroupsResult | null;
  big: boolean;
  onChange: (patch: Partial<StatsSpec>) => void;
  onRun: () => void;
}) {
  const num = columns.filter((c) => c.type === 'number').map((c) => c.name);
  const all = columns.map((c) => c.name);
  const typeTag = (c: string) => (columns.find((x) => x.name === c)?.type === 'number' ? 'Number' : 'Category');
  const noNumbers = <None>This dataset has no number columns.</None>;
  const opts = (list: string[]) => list.map((c) => ({ value: c, label: c }));

  let body: ReactNode;
  if (tab === 'correlation') {
    body = (
      <>
        <Section label="Columns" hint="Numeric columns — pick 2 to 12.">
          {num.length ? (
            <Checks name="Columns to correlate" items={num.map((c) => ({ value: c, label: c }))} chosen={spec.columns} onChange={(v) => onChange({ columns: v.slice(0, 12) })} />
          ) : (
            noNumbers
          )}
        </Section>
        <Section label="Method" hint="Spearman ranks the values first — robust to outliers and curved trends.">
          <Seg label="Correlation method" options={[['pearson', 'Pearson'], ['spearman', 'Spearman']]} value={spec.method ?? 'pearson'} onChange={(v) => onChange({ method: v as 'pearson' | 'spearman' })} />
        </Section>
      </>
    );
  } else if (tab === 'regression') {
    body = (
      <>
        <Section label="Target" hint="The number the model predicts.">
          {num.length ? (
            <Select
              aria-label="Target"
              value={spec.target ?? null}
              options={opts(num)}
              onValueChange={(v) => onChange({ target: v, predictors: (spec.predictors ?? []).filter((p) => p !== v) })}
            />
          ) : (
            noNumbers
          )}
        </Section>
        <Section label="Predictors" hint="Categories are one-hot encoded against their largest group.">
          <Checks
            name="Predictors"
            items={all.filter((c) => c !== spec.target).map((c) => ({ value: c, label: c, tag: typeTag(c) }))}
            chosen={spec.predictors ?? []}
            onChange={(v) => onChange({ predictors: v })}
          />
        </Section>
      </>
    );
  } else if (tab === 'groups') {
    const r = groups && groups.group === spec.group ? groups : null;
    body = (
      <>
        <Section label="Group by" hint="The column whose values form the groups.">
          <Select
            aria-label="Group by"
            placeholder="Choose a column"
            value={spec.group ?? null}
            options={opts(all)}
            onValueChange={(v) => onChange({ group: v, levels: [], success: undefined, outcome: spec.outcome === v ? '' : spec.outcome })}
          />
        </Section>
        <Section label="Outcome" hint="A number compares averages; a category compares shares.">
          <Select
            aria-label="Outcome"
            placeholder="Choose a column"
            value={spec.outcome || null}
            options={all.filter((c) => c !== spec.group).map((c) => ({ value: c, label: `${c} · ${typeTag(c).toLowerCase()}` }))}
            onValueChange={(v) => onChange({ outcome: v, success: undefined })}
          />
        </Section>
        <Section label="Groups" hint="Two groups get a t-test; three or more, an ANOVA.">
          {r && r.available.length ? (
            <Checks
              name="Groups to compare"
              items={r.available.map((a) => ({ value: a.level, label: a.level, tag: fmtCount(a.n) }))}
              chosen={spec.levels && spec.levels.length ? spec.levels : r.groups.map((g) => g.label)}
              onChange={(v) => onChange({ levels: v })}
            />
          ) : (
            <None>Run once to list this column’s groups; up to 20 are compared.</None>
          )}
        </Section>
        {r && r.prop && r.table && (
          <Section label="Counts as success" hint="The outcome value whose share is compared.">
            <Select aria-label="Counts as success" value={r.prop.success} options={opts(r.table.cols)} onValueChange={(v) => onChange({ success: v })} />
          </Section>
        )}
      </>
    );
  } else {
    body = (
      <Section label="Column" hint="A number column.">
        {num.length ? (
          <Select aria-label="Column" value={spec.columns[0] ?? null} options={opts(num)} onValueChange={(v) => onChange({ columns: [v] })} />
        ) : (
          noNumbers
        )}
      </Section>
    );
  }

  return (
    <aside className={s.controls} aria-label="Analysis settings">
      {body}
      <div className={s.ctlFoot}>
        <Button variant="primary" icon="play" block onClick={onRun}>
          Run analysis
        </Button>
        <p className={s.ctlHint}>{big ? 'A large dataset: the run goes to the background as a job.' : 'Re-runs as you change the settings.'}</p>
      </div>
    </aside>
  );
}
