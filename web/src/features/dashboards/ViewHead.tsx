// The view page's header (/dashboards/<p>/<id>), in place of the authoring strip: it reads like a published page.
// "Dashboards / <project>" back to the list, the name, how fresh the figures are (once, not on every card), and four
// actions: Compare (with As of and the currency when there is one), Subscribe, Expand and ⋯ (Copy link, Comments,
// Export HTML, Print). More than one sheet: underlined sheet tabs under it. Saved views sit in the filter box.

import { Link } from 'react-router';
import { IconButton } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { toast } from '../../ui/Toast';
import { useEditor } from '../analyses/editor/context';
import { useOverview } from '../projects/api';
import { SubscribeButton, ViewControls, exportHtml, useDashFreshness } from './DashboardChrome';
import s from './ViewHead.module.css';

/** This page's live in-app address, which anyone in the project can open. */
async function copyLink(projectId: string, id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/dashboards/${projectId}/${id}`);
    toast('Link copied', { kind: 'success' });
  } catch {
    toast('The clipboard is not available here.', { kind: 'error' });
  }
}

export function ViewHead() {
  const ed = useEditor();
  const { latest } = useDashFreshness(ed);
  // The shell already asked for the project list: the name costs no request.
  const project = useOverview().data?.find((p) => p.id === ed.projectId);
  const list = `/dashboards?project=${ed.projectId}`;
  const stamp = ed.view.asOf ? `As of ${new Date(ed.view.asOf).toLocaleString()}` : latest?.text;
  const warn = !ed.view.asOf && latest?.tone === 'warn';
  const { expanded, setExpanded } = ed.view;
  const sheets = ed.doc.sheets;
  return (
    <header className={s.head}>
      <div className={s.row}>
        <div className={s.ident}>
          <nav className={s.crumbs} aria-label="Breadcrumb">
            <Link to={list}>Dashboards</Link>
            {project && (
              <>
                <span className={s.slash} aria-hidden="true">
                  /
                </span>
                <Link to={list}>{project.name}</Link>
              </>
            )}
          </nav>
          <h1 className={s.name}>{ed.doc.name}</h1>
          {stamp && (
            <p className={warn ? `${s.stamp} ${s.warn}` : s.stamp} title={ed.view.asOf ? undefined : latest?.title}>
              {stamp}
            </p>
          )}
        </div>
        <div className={s.actions}>
          <ViewControls />
          <SubscribeButton />
          <IconButton
            icon={expanded ? 'minimize' : 'maximize'}
            size="sm"
            className={s.boxed}
            label={expanded ? 'Exit full screen' : 'Expand'}
            aria-pressed={expanded}
            onClick={() => setExpanded(!expanded)}
          />
          <Menu
            label="More dashboard actions"
            align="end"
            trigger={<IconButton icon="more-horizontal" size="sm" className={s.boxed} label="More dashboard actions" />}
            items={[
              { label: 'Copy link', icon: 'link', onSelect: () => void copyLink(ed.projectId, ed.analysisId) },
              { label: 'Comments', icon: 'message-square', onSelect: () => ed.view.openComments('all') },
              { kind: 'separator' },
              { label: 'Export HTML', icon: 'download', onSelect: () => void exportHtml(ed) },
              { label: 'Print or save as PDF', icon: 'file-text', onSelect: () => window.print() },
            ]}
          />
        </div>
      </div>
      {sheets.length > 1 && (
        <div className={s.tabs} role="tablist" aria-label="Sheets">
          {sheets.map((sh, i) => (
            <button key={sh.id} type="button" role="tab" aria-selected={i === ed.sheet} className={i === ed.sheet ? `${s.tab} ${s.on}` : s.tab} onClick={() => ed.setSheet(i)}>
              {sh.name}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
