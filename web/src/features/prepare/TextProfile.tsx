// A text column's profile (legacy textProfile.ts): for a column whose values
// average 20 characters or more — reviews, tickets, notes — its lengths, its
// language, its top terms and word pairs, and how positive it reads, with the
// three text steps one click away, prefilled. Every figure (and every bar's
// length, and the mood) is the server's (text:profile, over the first 5,000
// filled values). Exported for the dataset page's column profile (T2.3).

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { formatNumber } from '../../../../src/app/format.ts';
import { useTextProfile, type Bar, type TextProfileData } from './api';
import { TX_LANGS } from './FormsText';
import { fmtN } from './steps';
import { SentimentBar, signed } from './TextPreviews';
import s from './Prepare.module.css';

const BAND_TONES = ['neg2', 'neg', 'neu', 'pos', 'pos2'];

function TermBars({ title, list, empty }: { title: string; list: readonly Bar[]; empty: string }) {
  return (
    <section className={s.profileSection}>
      <h4 className={s.profileHead}>{title}</h4>
      {list.length === 0 ? (
        <p className={s.hint}>{empty}</p>
      ) : (
        <div className={s.bars}>
          {list.map((r) => (
            <div key={r.term} className={s.barRow}>
              <span className={s.barLabel} title={r.term}>
                {r.term}
              </span>
              <span className={s.barTrack}>
                <span className={s.barFill} style={{ width: `${r.barPct}%` }} />
              </span>
              <span className={s.barN}>{fmtN(r.count)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function TextProfile({
  projectId,
  datasetId,
  column,
  onOpenStep,
}: {
  projectId: string;
  datasetId: string;
  column: string;
  /** Opens a new text step prefilled from this profile. */
  onOpenStep: (type: string, prefill: Record<string, unknown>) => void;
}) {
  const [lang, setLang] = useState<TextProfileData['lang'] | undefined>(undefined);
  const q = useTextProfile(projectId, datasetId, column, lang);
  if (q.isPending) return <SkeletonRows rows={6} label="Reading the column’s text" />;
  if (q.isError) return <ErrorState compact heading={3} title="Could not read this column’s text." message={q.error.message} onRetry={() => void q.refetch()} />;
  const p = q.data;
  if (!p || !p.eligible) {
    return <p className={s.hint}>“{column}” holds short labels, not text — the Text profile is for reviews, tickets and notes (values that average 20 characters or more).</p>;
  }
  const terms = p.topTerms.map((t) => t.term);
  return (
    <div className={s.profile} aria-busy={q.isFetching || undefined}>
      <div className={s.profileTop}>
        <Select
          aria-label="Language for stop words"
          size="sm"
          value={p.lang}
          onValueChange={(v) => setLang(v as TextProfileData['lang'])}
          options={TX_LANGS.map(([v, l]) => ({ value: v, label: l + (v === p.detected ? ' (detected)' : '') }))}
        />
        <span className={s.hint}>{p.sampled < p.cap ? `All ${fmtN(p.sampled)} filled values.` : `The first ${fmtN(p.sampled)} filled values, in row order.`}</span>
      </div>
      <dl className={s.facts}>
        <dt>Average length</dt>
        <dd>{formatNumber(p.avgLength, { maxDecimals: 0 })} characters</dd>
        <dt>Median length</dt>
        <dd>{formatNumber(p.medianLength, { maxDecimals: 0 })} characters</dd>
      </dl>
      {p.sentiment && (
        <section className={s.profileSection}>
          <h4 className={s.profileHead}>Sentiment</h4>
          <div className={s.sentiHead}>
            <span className={`${s.sentiNum} ${s[p.mood ?? 'neutral'] ?? ''}`}>{signed(p.sentiment.mean, 2)}</span>
            <span className={s.muted}>average, {p.mood} (VADER, −1 to +1)</span>
          </div>
          <SentimentBar parts={p.sentiment.bands.map((b, k) => ({ label: b.label, count: b.count, tone: BAND_TONES[k] ?? 'neu' }))} />
          {p.lang !== 'en' && <p className={s.hint}>VADER’s lexicon is English — scores for other languages read only the English words in them.</p>}
        </section>
      )}
      <TermBars title="Top terms" list={p.topTerms} empty="No terms left after removing stop words." />
      <TermBars title="Top word pairs" list={p.topBigrams} empty="No word pairs repeat in these values." />
      <div className={s.actions}>
        <Button size="sm" title="A Prepare step: this column’s top terms as a table" onClick={() => onOpenStep('text_terms', { column, lang: p.lang, minN: 1, maxN: 2, top: 25 })}>
          Count terms
        </Button>
        <Button size="sm" title="A Prepare step: a sentiment score per row, −1 to +1" onClick={() => onOpenStep('text_sentiment', { column })}>
          Add sentiment
        </Button>
        <Button size="sm" title="A Prepare step: a category per row from keyword rules" onClick={() => onOpenStep('keyword_rules', { column, terms })}>
          Tag with rules
        </Button>
      </div>
    </div>
  );
}
