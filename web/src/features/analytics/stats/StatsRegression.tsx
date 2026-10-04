// Regression (statsViews.ts swViewRegression): the model's fit, its
// coefficients with each 95% interval drawn against zero, and the two
// diagnostic plots. Every estimate, interval and p arrives computed; the
// interval bars only place the server's numbers on a shared axis.

import type { ReactNode } from 'react';
import { Figure, Plot, axes } from '../Plot';
import type { StatsFigures, StatsResult } from '../api';
import { fmtCount, fmtFixed, fmtP, fmtStat, stars } from '../format';
import { ResultHead, Sentence, SigKey, StatRow } from './StatsParts';
import s from './Stats.module.css';
import a from '../Analytics.module.css';

type Reg = Extract<StatsResult, { kind: 'regression'; ok: true }>;

export function RegressionView({ r, figures, actions }: { r: Reg; figures: StatsFigures; actions: ReactNode }) {
  const f = r.fit;
  const refs = f.references.map((x) => `${x.column} = ${x.level}`).join(', ');
  const k = f.terms.length - 1;
  // The interval column's axis: every interval and zero, side by side.
  let lo = 0;
  let hi = 0;
  for (const t of f.terms.slice(1)) {
    lo = Math.min(lo, t.ciLow);
    hi = Math.max(hi, t.ciHigh);
  }
  const span = hi - lo || 1;
  const pos = (v: number) => ((v - lo) / span) * 100;
  const [rlo, rhi] = figures.residualSpan ?? [0, 0];
  const [qlo, qhi] = figures.qqSpan ?? [-3, 3];
  return (
    <>
      <ResultHead
        title={`Regression of ${f.target} on ${k} term${k === 1 ? '' : 's'}`}
        meta={`${fmtCount(f.n)} rows used${f.dropped ? ` · ${fmtCount(f.dropped)} dropped for a missing value` : ''}${refs ? ` · reference: ${refs}` : ''}`}
      >
        {actions}
      </ResultHead>
      <Sentence text={r.sentence} />
      <StatRow
        items={[
          ['R²', fmtFixed(f.r2, 3)],
          ['Adjusted R²', fmtFixed(f.adjR2, 3)],
          ['F', fmtStat(f.f), `on ${f.fDf1} and ${fmtCount(f.fDf2)} df`],
          ['Model p', fmtP(f.fP)],
          ['Residual SE', fmtStat(f.sigma)],
          ['n', fmtCount(f.n)],
        ]}
      />
      <div className={s.tableWrap}>
        <table className={`${s.table} ${s.coef}`}>
          <caption className={a.sr}>Coefficients</caption>
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col" className={s.num}>Estimate</th>
              <th scope="col" className={s.num}>Std. error</th>
              <th scope="col" className={s.num}>t</th>
              <th scope="col" className={s.num}>p</th>
              <th scope="col" className={s.sig} aria-label="Significance" />
              <th scope="col" className={s.ci}>95% confidence interval</th>
            </tr>
          </thead>
          <tbody>
            {f.terms.map((t, i) => {
              const sig = t.ciLow > 0 || t.ciHigh < 0;
              return (
                <tr key={t.name} className={t.p < 0.05 ? s.rowSig : undefined}>
                  <th scope="row">{t.name}</th>
                  <td className={s.num}>{fmtStat(t.estimate)}</td>
                  <td className={s.num}>{fmtStat(t.se)}</td>
                  <td className={s.num}>{fmtStat(t.t)}</td>
                  <td className={s.num}>{fmtP(t.p)}</td>
                  <td className={s.sig}>{stars(t.p)}</td>
                  <td className={s.ci}>
                    <span className={s.ciText}>{`${fmtStat(t.ciLow)} to ${fmtStat(t.ciHigh)}`}</span>
                    {i > 0 && (
                      <span className={s.ciBar} aria-hidden="true">
                        <span className={s.ciZero} style={{ left: `${pos(0)}%` }} />
                        <span
                          className={sig ? `${s.ciRange} ${s.ciRangeSig}` : s.ciRange}
                          style={{ left: `${pos(t.ciLow)}%`, width: `${Math.max(0.8, pos(t.ciHigh) - pos(t.ciLow))}%` }}
                        />
                        <span className={s.ciDot} style={{ left: `${pos(t.estimate)}%` }} />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SigKey />
      <div className={s.figGrid}>
        <Figure title="Residuals vs fitted" note="A shapeless band around zero is what a good fit looks like">
          <Plot
            label="Residuals vs fitted"
            deps={[f, rlo, rhi]}
            config={(th) => ({
              type: 'scatter',
              data: {
                datasets: [
                  { type: 'scatter', label: 'Residual', data: f.residuals.fitted.map((v, i) => ({ x: v, y: f.residuals.residual[i] })), backgroundColor: th.c1, pointRadius: 2 },
                  { type: 'line', label: 'Zero', data: [{ x: rlo, y: 0 }, { x: rhi, y: 0 }], borderColor: th.line, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0 },
                ],
              },
              options: { scales: axes(th, 'Fitted value', 'Residual', true), plugins: { legend: { display: false } } },
            })}
          />
        </Figure>
        <Figure title="Normal Q-Q" note="Standardised residuals against normal quantiles">
          <Plot
            label="Normal Q-Q"
            deps={[f, qlo, qhi]}
            config={(th) => ({
              type: 'scatter',
              data: {
                datasets: [
                  { type: 'scatter', label: 'Residual', data: f.qq.theoretical.map((v, i) => ({ x: v, y: f.qq.sample[i] })), backgroundColor: th.c2, pointRadius: 2 },
                  { type: 'line', label: 'Normal', data: [{ x: qlo, y: qlo }, { x: qhi, y: qhi }], borderColor: th.line, borderWidth: 1.5, pointRadius: 0 },
                ],
              },
              options: { scales: axes(th, 'Theoretical quantile', 'Sample quantile', true), plugins: { legend: { display: false } } },
            })}
          />
        </Figure>
      </div>
    </>
  );
}
