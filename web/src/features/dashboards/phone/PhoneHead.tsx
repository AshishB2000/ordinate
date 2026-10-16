// A dashboard's header on a phone (docs/phone-dashboards), in place of the
// authoring strip: back, the name on one line, how fresh the figures are, the
// Filters button with a badge counting what narrows the page, and ⋯ (Share,
// Comments). More than one sheet: a strip of sheet tabs under it, swiped
// sideways. It stays put while the sheet scrolls under it.

import { useState } from 'react';
import { Link } from 'react-router';
import { IconButton } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { useEditor } from '../../analyses/editor/context';
import { barControls } from '../../analyses/editor/FilterBar';
import { useDashFreshness } from '../DashboardChrome';
import { activeFilters, FiltersSheet } from './FiltersSheet';
import s from './Phone.module.css';

/** The OS share sheet where the browser has one; the clipboard otherwise. */
async function share(title: string): Promise<void> {
  const url = window.location.href;
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
    } catch {
      // dismissed: nothing to say
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied', { kind: 'success' });
  } catch {
    toast('The clipboard is not available here.', { kind: 'error' });
  }
}

export function PhoneHead() {
  const ed = useEditor();
  const [filters, setFilters] = useState(false);
  const { datasetIds, latest } = useDashFreshness(ed);
  const n = activeFilters(ed);
  // Something to set: a control on this sheet, or the view (Compare needs a figure on the dashboard).
  const hasFilters = barControls(ed.cards).length > 0 || datasetIds.length > 0;
  const sheets = ed.doc.sheets;
  const stamp = ed.view.asOf ? `As of ${new Date(ed.view.asOf).toLocaleString()}` : latest?.text;
  return (
    <header className={s.head}>
      <div className={s.bar}>
        <Link className={s.tap} to={`/analyses?project=${ed.projectId}`} aria-label="Back to Analyses">
          <Icon name="chevron-left" size={20} />
        </Link>
        <div className={s.ident}>
          <h1 className={s.name}>{ed.doc.name}</h1>
          {(stamp || ed.readOnly) && (
            <p className={latest?.tone === 'warn' && !ed.view.asOf ? `${s.stamp} ${s.warn}` : s.stamp} title={ed.view.asOf ? undefined : latest?.title}>
              {stamp}
              {stamp && ed.readOnly && ' · '}
              {ed.readOnly && 'View only'}
            </p>
          )}
        </div>
        {hasFilters && (
          <button
            type="button"
            className={n ? `${s.filters} ${s.filtersOn}` : s.filters}
            aria-haspopup="dialog"
            aria-label={n ? `Filters, ${n} active` : 'Filters'}
            onClick={() => setFilters(true)}
          >
            <Icon name="filter" size={16} />
            <span>Filters</span>
            {n > 0 && (
              <span className={s.badge} aria-hidden="true">
                {n}
              </span>
            )}
          </button>
        )}
        <Menu
          label="More dashboard actions"
          align="end"
          trigger={<IconButton icon="more-horizontal" label="More dashboard actions" className={s.tap} />}
          items={[
            { label: typeof navigator.share === 'function' ? 'Share…' : 'Copy link', icon: 'link', onSelect: () => void share(ed.doc.name) },
            { label: 'Comments', icon: 'message-square', onSelect: () => ed.view.openComments('all') },
          ]}
        />
      </div>
      {sheets.length > 1 && (
        <div className={s.sheets} role="tablist" aria-label="Sheets">
          {sheets.map((sh, i) => (
            <button
              key={sh.id}
              type="button"
              role="tab"
              aria-selected={i === ed.sheet}
              className={i === ed.sheet ? `${s.sheetTab} ${s.sheetOn}` : s.sheetTab}
              onClick={(e) => {
                ed.setSheet(i);
                e.currentTarget.scrollIntoView({ inline: 'center', block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
              }}
            >
              {sh.name}
            </button>
          ))}
        </div>
      )}
      <FiltersSheet ed={ed} open={filters} onOpenChange={setFilters} view />
    </header>
  );
}
