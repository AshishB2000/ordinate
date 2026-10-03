// The dataset page's Quality tab (dsRules.ts, dsExplorer.ts renderQuality,
// dsProfile.ts's completeness table): the rules you asked for, the issues the
// app volunteers, and — always — every column's completeness. Every count is
// the server's: the latest run and its 30-run history (`quality:list`), the
// failing rows (`quality:failingRows`), filled % (`dataset:stats`).

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useDatasets, type DatasetColumns } from '../../api/datasets';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { SkeletonRows, SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useQualityRules, useStats, useWrite, type ColumnSummary, type Quality, type Rule, type RuleDraft, type Stats } from './api';
import { ago, figure, formatNumber, rowsText } from './format';
import { RuleEditor } from './RuleEditor';
import { kindLabel, ruleWords } from './ruleWords';
import s from './Data.module.css';
import qs from './Quality.module.css';

type Status = 'fail' | 'warn' | 'pending' | 'pass';
const STATUS: Record<Status, { label: string; icon: IconName; rank: number }> = {
  fail: { label: 'Fail', icon: 'x', rank: 0 },
  warn: { label: 'Warn', icon: 'alert', rank: 1 },
  pending: { label: 'Not run', icon: 'minus', rank: 2 },
  pass: { label: 'Pass', icon: 'check', rank: 3 },
};

const resultOf = (q: Quality, id: string) => q.latest?.results.find((r) => r.ruleId === id);
function statusOf(rule: Rule, q: Quality): Status {
  const r = resultOf(q, rule.id);
  if (!r) return 'pending';
  if (r.passed) return 'pass';
  return rule.severity === 'warn' ? 'warn' : 'fail';
}

/** Failing rows over the last runs: a polyline over the server's counts (geometry, not arithmetic on the figures). */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <span className={s.muted}>{points.length ? 'One run' : 'No runs yet'}</span>;
  const w = 96;
  const h = 22;
  const max = Math.max(...points, 1);
  const d = points.map((v, i) => `${(i / (points.length - 1)) * w},${h - 1 - (v / max) * (h - 2)}`).join(' ');
  return (
    <svg className={qs.spark} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Failing rows over the last ${points.length} runs`}>
      <polyline points={d} fill="none" />
    </svg>
  );
}

/**
 * Up to three one-click rules the profile already argues for: a column that is
 * never empty, an id-like column whose values are all distinct, and a number
 * column's current range. The figures are the server's summaries; this only
 * picks which ones to offer.
 */
function suggestions(cols: DatasetColumns['columns'], sums: ColumnSummary[], n: number): RuleDraft[] {
  if (n <= 0) return [];
  const out: RuleDraft[] = [];
  const full = cols.filter((_, i) => sums[i]?.nonEmpty === n);
  const uniq = cols.find((c, i) => c.type === 'text' && n > 1 && sums[i]?.distinct === n && sums[i]?.nonEmpty === n);
  const others = full.filter((c) => c !== uniq);
  const likely = others.find((c) => c.type === 'date') ?? others.find((c) => /id|name|key|code/i.test(c.name)) ?? others[0];
  if (likely) out.push({ kind: 'not_null', column: likely.name, args: {}, severity: 'fail' });
  if (uniq) out.push({ kind: 'unique', column: uniq.name, args: {}, severity: 'fail' });
  const num = cols.findIndex((c, i) => c.type === 'number' && typeof sums[i]?.min === 'number' && sums[i]?.min !== sums[i]?.max);
  if (num >= 0) out.push({ kind: 'range', column: cols[num].name, args: { min: sums[num].min, max: sums[num].max }, severity: 'warn' });
  return out.slice(0, 3);
}

function Rules({ projectId, datasetId, header, stats }: { projectId: string; datasetId: string; header: DatasetColumns; stats: Stats | undefined }) {
  const q = useQualityRules(projectId, datasetId);
  const list = useDatasets(projectId);
  const [, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const refresh = ['quality:list', 'dataset:list'];
  const run = useWrite('quality:run', refresh, { onDone: (r) => r.ok && toast('Checks finished.', { kind: 'success' }) });
  const add = useWrite('quality:save', refresh);
  const del = useWrite('quality:delete', refresh, { onDone: () => setDeleting(null) });
  const names = new Map((list.data ?? []).map((d) => [d.id, d.name]));
  const failing = list.data?.find((d) => d.id === datasetId)?.qualityFailing ?? 0;

  if (q.isPending) return <SkeletonRows rows={3} label="Loading the rules" />;
  if (q.isError) return <ErrorState compact heading={3} title="The rules could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const quality = q.data;
  const rules = quality.rules.map((r, i) => ({ r, i, st: statusOf(r, quality) })).sort((a, b) => STATUS[a.st].rank - STATUS[b.st].rank || a.i - b.i);
  const showFailing = (r: Rule) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.delete('tab');
    n.delete('where');
    n.delete('is');
    n.set('rule', r.id);
    return n;
  });
  const sugg = stats ? suggestions(header.columns, stats.summaries, header.rowCount) : [];
  return (
    <section className={qs.qSection} aria-label="Data quality rules">
      <div className={qs.qHead}>
        <div>
          <h2 className={qs.qTitle}>Rules</h2>
          <p className={qs.qSub}>
            {rules.length === 0 ? (
              'Checks that run on every save and every refresh.'
            ) : (
              <>
                <span>{rules.length === 1 ? '1 rule' : `${formatNumber(rules.length)} rules`}</span>
                <span className={failing ? s.bad : s.good}>{formatNumber(failing)} failing</span>
                {quality.latest && <span>checked {ago(quality.latest.at)}</span>}
              </>
            )}
          </p>
        </div>
        <div className={qs.qActs}>
          {rules.length > 0 && (
            <Button size="sm" icon="refresh" loading={run.isPending} onClick={() => run.mutate({ projectId, datasetId })}>
              {run.isPending ? 'Checking…' : 'Run checks'}
            </Button>
          )}
          <Button size="sm" variant="primary" icon="plus" onClick={() => setEditing('new')}>
            Add rule
          </Button>
        </div>
      </div>
      {rules.length === 0 ? (
        <EmptyState
          compact
          heading={3}
          icon="check"
          title="No rules yet"
          actions={
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              Add rule
            </Button>
          }
        >
          Rules check this dataset on every save and every refresh, and a failing one puts a red dot on it everywhere it is listed.
        </EmptyState>
      ) : (
        <div className={s.card}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Rule</th>
                <th scope="col">Severity</th>
                <th scope="col" className={s.num}>
                  Failing
                </th>
                <th scope="col">Last 30 runs</th>
                <th scope="col" className={s.actions}>
                  <span className={s.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map(({ r, st }) => {
                const res = resultOf(quality, r.id);
                const points = quality.history.map((h) => h.failing[r.id]).filter((n): n is number => typeof n === 'number');
                return (
                  <tr key={r.id} data-rule-id={r.id}>
                    <td>
                      <span className={`${qs.qPill} ${qs[`q_${st}`]}`}>
                        <Icon name={STATUS[st].icon} size={12} />
                        {STATUS[st].label}
                      </span>
                    </td>
                    <td>
                      <span className={qs.qRule}>
                        <span className={s.strong}>{ruleWords(r, names)}</span>
                        <span className={s.meta}>{kindLabel(r.kind)}</span>
                        {res?.error && <span className={s.rowError}>{res.error}</span>}
                      </span>
                    </td>
                    <td>
                      <span className={r.severity === 'warn' ? s.warnText : s.failText}>{r.severity === 'warn' ? 'Warn' : 'Fail'}</span>
                    </td>
                    <td className={s.num}>{!res || res.error || res.passed ? '—' : r.kind === 'row_count' ? 'Out of range' : rowsText(res.failing)}</td>
                    <td className={qs[`spark_${st}`]}>
                      <Sparkline points={points} />
                    </td>
                    <td className={s.actions}>
                      <span className={s.rowActions}>
                        {res && !res.passed && !res.error && r.kind !== 'row_count' && res.failing > 0 && (
                          <Button size="sm" variant="ghost" icon="filter" onClick={() => showFailing(r)}>
                            Show failing rows
                          </Button>
                        )}
                        <Menu
                          align="end"
                          trigger={<IconButton icon="more-horizontal" size="sm" label={`Actions for ${ruleWords(r, names)}`} />}
                          items={[
                            { label: 'Edit rule', icon: 'pencil', onSelect: () => setEditing(r) },
                            { kind: 'separator' },
                            { label: 'Delete rule', icon: 'trash', danger: true, onSelect: () => setDeleting(r) },
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rules.length === 0 && sugg.length > 0 && (
        <div className={qs.qSuggest}>
          <span className={s.meta}>Suggested from this data</span>
          {sugg.map((r) => (
            <button key={`${r.kind}:${r.column}`} type="button" className={qs.qChip} disabled={add.isPending} onClick={() => add.mutate({ projectId, datasetId, rule: r })}>
              <Icon name="plus" size={12} />
              {ruleWords(r, names)}
            </button>
          ))}
        </div>
      )}
      {editing && (
        <RuleEditor
          projectId={projectId}
          datasetId={datasetId}
          header={header}
          summaries={stats?.summaries ?? []}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <Dialog
          open
          size="sm"
          onOpenChange={(o) => !o && setDeleting(null)}
          title="Delete this rule?"
          description={ruleWords(deleting, names)}
          footer={
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button variant="danger" loading={del.isPending} onClick={() => del.mutate({ projectId, datasetId, ruleId: deleting.id })}>
                Delete rule
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}

function Completeness({ header, stats }: { header: DatasetColumns; stats: Stats }) {
  return (
    <div className={s.card}>
      <table className={s.table} aria-label="Completeness of every column">
        <thead>
          <tr>
            <th scope="col">Column</th>
            <th scope="col">Type</th>
            <th scope="col">Filled</th>
            <th scope="col" className={s.num}>
              Distinct
            </th>
            <th scope="col">Most common · range</th>
          </tr>
        </thead>
        <tbody>
          {header.columns.map((c, i) => {
            const sum = stats.summaries[i];
            const pct = stats.filledPct[i];
            return (
              <tr key={c.name}>
                <td className={s.strong}>{c.name}</td>
                <td>
                  <span className={s.typeChip}>{c.type}</span>
                </td>
                <td>
                  {typeof pct === 'number' ? (
                    <span className={qs.fill}>
                      <span className={`${qs.fillTrack} ${pct < 50 ? qs.fillLow : ''}`}>
                        <span style={{ width: `${pct}%` }} />
                      </span>
                      <span className={s.meta}>{pct}%</span>
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={s.num} title={typeof sum?.distinct === 'number' ? undefined : 'Counted on demand — open this column’s profile'}>
                  {figure(sum?.distinct)}
                </td>
                <td className={s.meta}>
                  {sum?.type === 'number'
                    ? typeof sum.min === 'number' && typeof sum.max === 'number'
                      ? `${figure(sum.min)} – ${figure(sum.max)}`
                      : '—'
                    : sum?.mostCommon
                      ? `${sum.mostCommon.value} (${rowsText(sum.mostCommon.count)})`
                      : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function QualityTab({ projectId, datasetId, header }: { projectId: string; datasetId: string; header: DatasetColumns }) {
  const stats = useStats(projectId, datasetId);
  return (
    <div className={qs.quality}>
      <Rules projectId={projectId} datasetId={datasetId} header={header} stats={stats.data} />
      <section className={qs.qSection} aria-label="Findings and completeness">
        <h2 className={qs.qTitle}>Columns</h2>
        {stats.isPending ? (
          <SkeletonTable cols={5} rows={Math.min(8, header.columns.length || 1)} label="Reading every column" />
        ) : stats.isError ? (
          <ErrorState compact heading={3} title="The columns could not be checked" message={stats.error.message} onRetry={() => void stats.refetch()} />
        ) : (
          <>
            {stats.data.issues.length > 0 ? (
              <div className={qs.issues}>
                {stats.data.issues.map((i, k) => (
                  <span key={k} className={`${qs.issue} ${i.severity === 'warn' ? qs.issueWarn : ''}`}>
                    {i.detail}
                  </span>
                ))}
              </div>
            ) : (
              <p className={qs.allGood}>
                <Icon name="check" />
                No issues found in this dataset.
              </p>
            )}
            <Completeness header={header} stats={stats.data} />
          </>
        )}
      </section>
    </div>
  );
}
