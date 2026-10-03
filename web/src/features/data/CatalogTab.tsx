// The Catalog tab (catalogPage.ts): every record of every kind with its
// description, tags, owner, last update, how much uses it and whether a
// scheduled dataset has gone stale. Rows, usage, staleness and the kind
// counts all come from `catalog:list`; this tab only filters what it shows.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Badge } from '../../ui/Badge';
import { Button, buttonClass, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { VIZ_LABELS } from '../../charts/vizLabels';
import { useCatalog, useTags, type CatalogRow } from './api';
import { RecordDetails } from './Details';
import { ago, formatNumber, fromControl, stamp } from './format';
import { normTag, TagChips, TagFilterBar, useActiveTag } from './tags';
import s from './Data.module.css';

const KIND_ICON: Record<string, IconName> = {
  dataset: 'database', visual: 'chart-bar', analysis: 'layout-dashboard', metric: 'chart-line', report: 'file-text', story: 'file-text',
};

/** Where a record opens. The dataset page is here; the others are their own areas. */
export function recordHref(projectId: string, r: { kind: string; id: string }): string {
  switch (r.kind) {
    case 'dataset':
      return `/data/${projectId}/${r.id}`;
    case 'visual':
      return `/visuals?project=${projectId}&id=${r.id}`;
    case 'analysis':
      return `/dashboards?project=${projectId}&id=${r.id}`;
    case 'report':
      return `/reports?project=${projectId}&id=${r.id}`;
    default:
      return `/analyses?project=${projectId}&${r.kind}=${r.id}`;
  }
}

function matches(r: CatalogRow, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith('#')) return r.tags.some((t) => t.name.startsWith(normTag(q)));
  return [r.name, r.description, r.owner, r.type].some((v) => v.toLowerCase().includes(q));
}

function Row({ projectId, r }: { projectId: string; r: CatalogRow }) {
  const navigate = useNavigate();
  const href = recordHref(projectId, r);
  const kindSub = r.kind === 'visual' ? (VIZ_LABELS as Record<string, string>)[r.sub] ?? r.sub : r.sub;
  const sub = [r.type, kindSub].filter(Boolean).join(' · ');
  return (
    <tr className={s.clickRow} onClick={(e) => !fromControl(e.target) && void navigate(href)}>
      <td>
        <span className={s.ctName}>
          <span className={`${s.kindIcon} ${s[`kind_${r.kind}`] ?? ''}`} aria-hidden="true">
            <Icon name={KIND_ICON[r.kind] ?? 'folder'} />
          </span>
          <span className={s.ctText}>
            <span className={s.ctTop}>
              <Link className={s.nameLink} to={href} aria-label={`Open ${r.type} ${r.name}`}>
                {r.name || 'Untitled'}
              </Link>
              {r.stale && (
                <span title="On a refresh schedule, but no refresh has landed in more than two schedule periods.">
                  <Badge tone="warn">Stale</Badge>
                </span>
              )}
            </span>
            <span className={s.ctSub} title={r.description || undefined}>
              {sub}
              {r.description ? ` — ${r.description}` : ''}
            </span>
          </span>
        </span>
      </td>
      <td>
        <TagChips tags={r.tags} />
      </td>
      <td className={r.owner ? '' : s.muted}>{r.owner || '—'}</td>
      <td className={s.meta} title={r.updatedAt ? `${stamp(r.updatedAt)}${r.updatedBy ? ` · docs by ${r.updatedBy}` : ''}` : undefined}>
        {r.updatedAt ? ago(r.updatedAt) : '—'}
      </td>
      <td className={`${s.num} ${r.usage ? '' : s.muted}`} title={r.usage ? `Used by ${formatNumber(r.usage)} other records` : 'Nothing in this project uses it'}>
        {r.usage ? formatNumber(r.usage) : 'Unused'}
      </td>
      <td className={s.actions}>
        <RecordDetails
          projectId={projectId}
          kind={r.kind}
          id={r.id}
          name={r.name}
          trigger={<IconButton icon="info" size="sm" label={`Details for ${r.name}`} />}
        />
      </td>
    </tr>
  );
}

export function CatalogTab({ projectId }: { projectId: string }) {
  const q = useCatalog(projectId);
  const tags = useTags(projectId);
  const [text, setText] = useState('');
  const [kind, setKind] = useState('');
  const [tag, setTag] = useActiveTag();

  if (q.isPending) return <SkeletonTable cols={6} rows={6} label="Loading the catalog" />;
  if (q.isError) return <ErrorState heading={3} title="The catalog could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const { rows, kinds } = q.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon="list"
        heading={3}
        title="Nothing to catalog yet"
        actions={
          <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
            Import a dataset
          </Link>
        }
      >
        Every dataset, visual, dashboard, metric and report in this project is listed here with its description, tags and
        owner — so anyone can find the right one and know who to ask.
      </EmptyState>
    );
  }
  const activeKind = kinds.some((k) => k.kind === kind) ? kind : '';
  const shown = rows.filter((r) => (!activeKind || r.kind === activeKind) && matches(r, text) && (!tag || r.tags.some((t) => t.name === tag)));
  const present = [...new Set(rows.flatMap((r) => r.tags.map((t) => t.name)))];
  const plural = (label: string) => (label.endsWith('y') ? `${label.slice(0, -1)}ies` : `${label}s`);
  const clear = () => {
    setText('');
    setKind('');
    setTag('');
  };
  return (
    <section className={s.section} aria-label="Catalog">
      <div className={s.listBar}>
        <Input
          type="search"
          icon="search"
          size="sm"
          className={s.ctSearch}
          aria-label="Filter the catalog"
          placeholder="Filter by name, description, owner or #tag"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className={s.pills} role="group" aria-label="Record kinds">
          {[{ kind: '', label: 'All', count: rows.length }, ...kinds.map((k) => ({ ...k, label: plural(k.label) }))].map((k) => (
            <button key={k.kind} type="button" className={`${s.pill} ${k.kind === activeKind ? s.pillOn : ''}`} aria-pressed={k.kind === activeKind} onClick={() => setKind(k.kind)}>
              {k.label}
              <span className={s.pillN}>{formatNumber(k.count)}</span>
            </button>
          ))}
        </div>
      </div>
      <TagFilterBar present={present} index={tags.data} active={tag} onPick={setTag} empty={shown.length === 0} />
      {shown.length === 0 ? (
        <EmptyState compact heading={3} icon="search" title="Nothing matches these filters" actions={<Button size="sm" onClick={clear}>Clear filters</Button>} />
      ) : (
        <div className={s.card}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Tags</th>
                <th scope="col">Owner</th>
                <th scope="col">Updated</th>
                <th scope="col" className={s.num}>
                  Used by
                </th>
                <th scope="col" className={s.actions}>
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Row key={r.ref} projectId={projectId} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
