// Search inside the data (dataSearch.ts — ⌘K's "Data" group on the desktop):
// type "California" or "INV-2041" and find the value in this project's text
// columns. The server answers from each dataset's value index or a bounded
// scan, and counts the rows; a hit opens the dataset filtered to it, or its
// column's profile. (The desktop's third action, "Filter this dashboard",
// needs an open dashboard — it returns with the command palette, T2.14.)

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { buttonClass } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { useDataSearch } from './api';
import { rowsText } from './format';
import s from './Data.module.css';

export function DataSearch({ projectId }: { projectId: string }) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  // One query per pause, not per keystroke: a search can scan every dataset.
  useEffect(() => {
    const t = setTimeout(() => setTerm(text), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useDataSearch(projectId, term);
  const on = term.trim().length >= 2;
  const base = (id: string) => `/data/${projectId}/${id}`;
  return (
    <section className={s.search} aria-label="Search inside the data">
      <Input
        type="search"
        icon="search"
        aria-label="Search values in this project's datasets"
        placeholder="Find a value in your data — a name, an id, a place…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setText('')}
      />
      {on && (
        <div className={s.hits} role="region" aria-live="polite" aria-label="Values found">
          {q.isPending ? (
            <SkeletonRows rows={3} label="Searching values inside your datasets" />
          ) : q.isError ? (
            <ErrorState compact heading={3} title="The search did not finish" message={q.error.message} onRetry={() => void q.refetch()} />
          ) : q.data.hits.length === 0 ? (
            <EmptyState compact heading={3} icon="search" title={`No value matches “${term.trim()}”`}>
              Text columns of every dataset in this project were searched.
            </EmptyState>
          ) : (
            <ul className={s.hitList}>
              {q.data.partial.length > 0 && <li className={s.muted}>Some large datasets were only partly searched.</li>}
              {q.data.hits.map((h) => (
                <li key={`${h.datasetId}:${h.column}:${h.value}`} className={s.hit}>
                  <span className={s.hitValue}>{h.value}</span>
                  <span className={s.hitWhere}>
                    {h.datasetName} / {h.column}
                  </span>
                  <span className={s.hitRows}>{rowsText(h.rows)}</span>
                  <Link
                    className={buttonClass('secondary', 'sm')}
                    to={`${base(h.datasetId)}?${new URLSearchParams({ where: h.column, is: h.value })}`}
                  >
                    Open filtered
                  </Link>
                  <Link className={buttonClass('ghost', 'sm')} to={`${base(h.datasetId)}?${new URLSearchParams({ profile: h.column })}`}>
                    Profile the column
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
