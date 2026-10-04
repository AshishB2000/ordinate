// The pieces every statistics result shares (statsPanel.ts swResultHead,
// swSentence, swStatRow; statsViewsGroups.ts swTestCard, swSimpleTable,
// swWarnings). Layout only — every value arrives as text or a computed number.

import type { ReactNode } from 'react';
import { EmptyState } from '../../../ui/States';
import { Icon } from '../../../ui/icons/Icon';
import s from './Stats.module.css';
import a from '../Analytics.module.css';

export function ResultHead({ title, meta, children }: { title: string; meta: string; children?: ReactNode }) {
  return (
    <div className={s.resultHead}>
      <div>
        <h2 className={s.resultTitle}>{title}</h2>
        <p className={s.resultMeta}>{meta}</p>
      </div>
      <div className={s.resultActions}>{children}</div>
    </div>
  );
}

/** The app's own sentence, set apart as the headline finding. */
export function Sentence({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className={s.sentence}>
      <Icon name="check" />
      <span>{text}</span>
    </p>
  );
}

/** A row of labelled figures. */
export function StatRow({ items }: { items: Array<[string, string, string?]> }) {
  return (
    <div className={s.stats}>
      {items.map(([label, value, note]) => (
        <div key={label} className={s.stat}>
          <div className={s.statLabel}>{label}</div>
          <div className={s.statValue}>{value}</div>
          {note && <div className={s.statNote}>{note}</div>}
        </div>
      ))}
    </div>
  );
}

export function SigKey() {
  return <p className={s.footnote}>Significance: *** p &lt; 0.001 · ** p &lt; 0.01 · * p &lt; 0.05 · · p &lt; 0.1. Two-sided tests.</p>;
}

/** One test's card: its name, the verdict at p < 0.05 (the server's p), and its figures. */
export function TestCard({ title, p, rows, note }: { title: string; p: number; rows: Array<[string, string]>; note?: string }) {
  const sig = p < 0.05;
  return (
    <section className={s.card} aria-label={title}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>{title}</h3>
        <span className={`${s.verdict} ${sig ? s.isSig : s.isNs}`}>{sig ? 'Significant' : 'Not significant'}</span>
      </div>
      <dl className={s.dl}>
        {rows.map(([k, v]) => (
          <div key={k} className={s.dlRow}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {note && <p className={s.cardNote}>{note}</p>}
    </section>
  );
}

export function SimpleTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className={a.sr}>{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={i > 0 ? s.num : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {v}
                  </th>
                ) : (
                  <td key={j} className={s.num}>
                    {v}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Warnings({ list }: { list: readonly string[] }) {
  return list.map((w) => (
    <p key={w} className={s.warn}>
      <Icon name="alert" />
      <span>{w}</span>
    </p>
  ));
}

/** The shared failure state: the app's own reason, never a stack. */
export function Problem({ message }: { message: string }) {
  const title = /^Pick /.test(message) ? 'Choose what to analyse' : /^Need /.test(message) ? 'Not enough data' : 'This analysis cannot run';
  return (
    <EmptyState icon="info" title={title} heading={2}>
      {message}
    </EmptyState>
  );
}
