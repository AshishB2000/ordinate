// The text steps' live previews (legacy textPreviews.ts) — what the server
// computed for an unsaved step, laid out: the first rows of a terms table, the
// sentiment spread with the most positive and most negative row, the rows each
// keyword category gets (with the share and bar the server worked out).
// SentimentBar is shared with the column profile's Text section.

import { formatNumber } from '../../../../src/app/format.ts';
import type { TextPreview } from './api';
import { fmtN } from './steps';
import s from './Prepare.module.css';

/** ±0.123 with a real minus — a score as the previews print it. */
export function signed(v: number, decimals: number): string {
  return (v > 0 ? '+' : v < 0 ? '−' : '') + formatNumber(Math.abs(v), { decimals });
}

function SampleLine({ res }: { res: TextPreview }) {
  if (!res.sampled) return null;
  return (
    <div className={s.muted}>
      Preview of the first {fmtN(res.sampleRows)} of {fmtN(res.total)} rows — saving runs on every row.
    </div>
  );
}

function Warnings({ list }: { list: readonly string[] | undefined }) {
  return (list ?? []).map((w) => <div key={w}>{w}</div>);
}

export function TermsPreview({ res }: { res: TextPreview }) {
  const cols = res.columns ?? [];
  const rows = res.rows ?? [];
  return (
    <>
      <div>
        Rows: {fmtN(res.before)} → {fmtN(res.after)} terms
      </div>
      {rows.length > 0 && (
        <table className={s.miniTable}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, k) => (
                  <td key={k} className={typeof v === 'number' ? s.num : undefined}>
                    {typeof v === 'number' ? (cols[k] === 'tfidf' || cols[k] === 'sentiment' ? formatNumber(v, { decimals: 4 }) : fmtN(v)) : String(v ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Warnings list={res.warnings} />
      <SampleLine res={res} />
    </>
  );
}

/** A stacked bar of counts with a legend under it. Each segment grows by its own count — no share is computed here. */
export function SentimentBar({ parts }: { parts: readonly { label: string; count: number; tone: string }[] }) {
  return (
    <div className={s.senti}>
      <div className={s.sentiBar} role="img" aria-label={parts.map((p) => `${p.label} ${fmtN(p.count)}`).join(', ')}>
        {parts
          .filter((p) => p.count > 0)
          .map((p) => (
            <span key={p.label} className={`${s.sentiSeg} ${s[p.tone] ?? ''}`} title={`${p.label} · ${fmtN(p.count)}`} style={{ flexGrow: p.count }} />
          ))}
      </div>
      <div className={s.sentiLegend}>
        {parts.map((p) => (
          <span key={p.label} className={`${s.sentiKey} ${s[p.tone] ?? ''}`}>
            {p.label} {fmtN(p.count)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SentimentPreview({ res }: { res: TextPreview }) {
  const st = res.sentiment;
  if (!st) return <Warnings list={res.warnings?.length ? res.warnings : ['Nothing to score.']} />;
  return (
    <>
      <div>
        {fmtN(st.scored)} rows scored{st.empty ? ` · ${fmtN(st.empty)} empty` : ''}
        {typeof st.mean === 'number' ? ` · average ${signed(st.mean, 3)}` : ''}
      </div>
      <SentimentBar
        parts={[
          { label: 'Negative', count: st.negative, tone: 'neg' },
          { label: 'Neutral', count: st.neutral, tone: 'neu' },
          { label: 'Positive', count: st.positive, tone: 'pos' },
        ]}
      />
      {st.examples.map((ex, i) => (
        <div key={i} className={s.example}>
          <span className={s.score}>{signed(ex.score, 4)}</span>
          <span>{ex.text}</span>
        </div>
      ))}
      <SampleLine res={res} />
    </>
  );
}

export function CategoryPreview({ res }: { res: TextPreview }) {
  const cats = res.categories ?? [];
  return (
    <>
      <div className={s.bars}>
        {cats.map((c) => (
          <div key={c.category} className={s.barRow}>
            <span className={s.barLabel} title={c.category}>
              {c.category === '' ? '(empty)' : c.category + (c.isDefault ? ' (otherwise)' : '')}
            </span>
            <span className={s.barTrack}>
              <span className={c.isDefault ? `${s.barFill} ${s.barDefault}` : s.barFill} style={{ width: `${c.barPct}%` }} />
            </span>
            <span className={s.barN}>
              {fmtN(c.count)} · {c.pct}%
            </span>
          </div>
        ))}
      </div>
      <Warnings list={res.warnings} />
      <SampleLine res={res} />
    </>
  );
}
