// Correlation (statsViews.ts swViewCorrelation / swShowPair): the matrix as a
// heatmap — a cell with an r is a button that opens that pair's scatter with
// its fitted line — then the selected pair's figures. The cell colour is the
// server's r mapped onto the two theme ends; every number is the server's.

import type { ReactElement, ReactNode } from 'react';
import { Button } from '../../../ui/Button';
import { ErrorState } from '../../../ui/States';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { Tooltip } from '../../../ui/Tooltip';
import { Figure, Plot, axes } from '../Plot';
import { useStatsPair, type CorrCell, type StatsResult, type StatsSpec } from '../api';
import { fmtCount, fmtFixed, fmtP, fmtStat, stars } from '../format';
import { ResultHead, Sentence, SigKey, StatRow } from './StatsParts';
import s from './Stats.module.css';
import a from '../Analytics.module.css';

type Corr = Extract<StatsResult, { kind: 'correlation'; ok: true }>;

function Cell({ c, i, j, row, col, sym, onPick, picked }: { c: CorrCell; i: number; j: number; row: string; col: string; sym: string; onPick: () => void; picked: boolean }) {
  const live = i !== j && c.r !== null;
  const text =
    i === j
      ? `${row}: ${fmtCount(c.n)} values`
      : c.r === null
        ? `${row} × ${col}: not enough rows with both (${fmtCount(c.n)})`
        : `${row} × ${col}: ${sym} = ${fmtFixed(c.r, 3)}, p ${fmtP(c.p)}, n = ${fmtCount(c.n)}`;
  const shown = i === j ? '1' : c.r === null ? '—' : fmtFixed(c.r, 2) + stars(c.p);
  const cls = [s.cell, i === j && s.isDiag, live && Math.abs(c.r as number) >= 0.7 && s.isStrong, picked && s.isPicked].filter(Boolean).join(' ');
  const style =
    typeof c.r === 'number'
      ? { background: `color-mix(in srgb, var(${c.r >= 0 ? '--sw-pos' : '--sw-neg'}) ${Math.round(Math.min(1, Math.abs(c.r)) * 55)}%, var(--surface))` }
      : undefined;
  const el: ReactElement = live ? (
    <button type="button" className={cls} style={style} aria-label={`${text}. Open the scatter.`} aria-pressed={picked} onClick={onPick}>
      {shown}
    </button>
  ) : (
    <span className={cls} style={style} role="img" aria-label={text} tabIndex={0}>
      {shown}
    </span>
  );
  return <Tooltip content={text}>{el}</Tooltip>;
}

export function CorrelationView({
  r,
  spec,
  pair,
  onPair,
  onModel,
  actions,
  projectId,
}: {
  r: Corr;
  spec: StatsSpec;
  pair: [string, string] | null;
  onPair: (p: [string, string]) => void;
  onModel: (target: string, predictor: string) => void;
  actions: ReactNode;
  projectId: string;
}) {
  const { columns, cells, method } = r.matrix;
  const sym = method === 'spearman' ? 'ρ' : 'r';
  const name = method === 'spearman' ? 'Spearman' : 'Pearson';
  const live = pair && columns.includes(pair[0]) && columns.includes(pair[1]) ? pair : null;
  return (
    <>
      <ResultHead title={`${name} correlation · ${columns.length} columns`} meta={`${fmtCount(r.rows)} rows · each pair on the rows where both have a value · p from t on n − 2 df`}>
        {actions}
      </ResultHead>
      <div className={s.heatWrap}>
        <table className={s.heat}>
          <caption className={a.sr}>{`${name} correlation matrix`}</caption>
          <thead>
            <tr>
              <td />
              {columns.map((c) => (
                <th key={c} scope="col" title={c}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {columns.map((row, i) => (
              <tr key={row}>
                <th scope="row" title={row}>
                  {row}
                </th>
                {columns.map((col, j) => (
                  <td key={col}>
                    <Cell
                      c={cells[i][j]}
                      i={i}
                      j={j}
                      row={row}
                      col={col}
                      sym={sym}
                      picked={!!live && live[0] === row && live[1] === col}
                      onPick={() => onPair([row, col])}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.heatLegend} aria-hidden="true">
        <span>−1 negative</span>
        <span className={s.legBar} />
        <span>+1 positive</span>
      </div>
      <SigKey />
      <section className={s.pair} aria-label="Selected pair">
        {live ? (
          <Pair projectId={projectId} spec={spec} pair={live} sym={sym} onModel={onModel} />
        ) : (
          <p className={s.pairHint}>Select a cell to see that pair’s scatter with its fitted line.</p>
        )}
      </section>
    </>
  );
}

function Pair({ projectId, spec, pair, sym, onModel }: { projectId: string; spec: StatsSpec; pair: [string, string]; sym: string; onModel: (y: string, x: string) => void }) {
  const q = useStatsPair(projectId, spec, pair);
  const [x, y] = pair;
  if (q.isPending) return <SkeletonBlock label="Loading the pair" />;
  const res = q.data;
  if (!res || !res.ok) return <ErrorState title="That pair cannot be drawn" message={res && !res.ok ? res.error : 'Could not draw that pair.'} compact heading={3} />;
  const p = res.pair;
  const c = p.cell;
  const items: Array<[string, string, string?]> = [[sym, fmtFixed(c.r, 3)], ['p', fmtP(c.p)], ['n', fmtCount(c.n)]];
  if (p.fit) items.push(['Slope', fmtStat(p.fit.slope), `${y} per unit of ${x}`], ['Intercept', fmtStat(p.fit.intercept)]);
  const line = res.line;
  return (
    <>
      <div className={s.pairHead}>
        <h3 className={s.pairTitle}>{`${x} × ${y}`}</h3>
        <Button size="sm" icon="trending-up" onClick={() => onModel(y, x)}>
          {`Model ${y} on ${x}`}
        </Button>
      </div>
      <Sentence text={p.sentence} />
      <StatRow items={items} />
      <Figure
        title={`${p.y} against ${p.x}`}
        note={p.shown < p.n ? `${fmtCount(p.shown)} of ${fmtCount(p.n)} points shown, evenly thinned` : `${fmtCount(p.n)} points`}
        tall
      >
        <Plot
          label={`${p.y} against ${p.x}`}
          deps={[p, line]}
          config={(th) => ({
            type: 'scatter',
            data: {
              datasets: [
                { type: 'scatter', label: 'Rows', data: p.points.x.map((v, i) => ({ x: v, y: p.points.y[i] })), backgroundColor: th.c1, pointRadius: 2.5, pointHoverRadius: 4 },
                ...(line
                  ? [{ type: 'line', label: 'Fit', data: [{ x: line.x0, y: line.y0 }, { x: line.x1, y: line.y1 }], borderColor: th.line, borderWidth: 2, pointRadius: 0, fill: false }]
                  : []),
              ],
            },
            options: { scales: axes(th, p.x, p.y, true), plugins: { legend: { display: false } } },
          })}
        />
      </Figure>
    </>
  );
}
