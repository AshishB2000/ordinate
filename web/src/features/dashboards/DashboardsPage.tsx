// /dashboards?project=<id> — the project's one list of dashboards: drafts and published ones for an editor, the
// published ones for everyone else (list/DashboardList). The published snapshots (T2.9, served at /p/<id>/) still have
// their list at `&tab=links` (or `&dashboard=<id>`, which opens Publish on it): each link, who may open it, and the way
// to copy, publish again, change access or take it down. Nothing in the app links there any more; the address is kept
// for the /p/ and embed flows.

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { ago } from '../../app/when';
import { Button, buttonClass, IconButton } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { ProjectGate } from '../import/ProjectGate';
import { useCanEdit } from '../projects/api';
import { reason, siteUrl, usePublishActions, useSites, type HostedSite } from './api';
import { PublishDialog } from './PublishDialog';
import { EmbedDialog } from './EmbedDialog';
import { DashboardList } from './list/DashboardList';
import p from './Publish.module.css';

const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function SiteRow({ site, projectId, publicLinks, onRepublish, onEmbed, canEdit }: {
  site: HostedSite; projectId: string; publicLinks: boolean; onRepublish: () => void; onEmbed: () => void; canEdit: boolean;
}) {
  const { access, unpublish } = usePublishActions(projectId);
  const [armed, setArmed] = useState(false);
  const url = siteUrl(site.id);
  const copy = () =>
    navigator.clipboard.writeText(url).then(
      () => toast('Link copied', { kind: 'success' }),
      () => toast('The clipboard is not available here.', { kind: 'error' }),
    );
  const name = site.title || site.pages.map((x) => x.name).join(', ') || 'Published site';
  const fail = (e: unknown) => toast(reason(e, 'That did not work.'), { kind: 'error' });
  return (
    <li className={p.site} aria-label={name}>
      <span className={p.siteIcon} aria-hidden="true">
        <Icon name="globe" />
      </span>
      <div className={p.siteMain}>
        <a className={p.siteName} href={url} target="_blank" rel="noopener noreferrer">
          {name}
        </a>
        <div className={p.siteMeta}>
          {site.pages.length === 1 ? '1 page' : `${site.pages.length} pages`} · {size(site.bytes)} · published {ago(site.publishedAt)} by {site.publishedBy}
          {site.config.options.afterRefresh ? ' · re-publishes after data refreshes' : ''}
        </div>
        <code className={p.url}>{url}</code>
      </div>
      <span className={site.access === 'link' ? `${p.access} ${p.public}` : p.access} title={site.access === 'link' && !publicLinks ? 'Public links are off for your organisation: only members can open it.' : undefined}>
        <Icon name={site.access === 'link' ? 'globe' : 'lock'} size={12} />
        {site.access === 'link' ? (publicLinks ? 'Anyone with the link' : 'Anyone with the link (off)') : 'Your organisation'}
      </span>
      <div className={p.siteActions}>
        <Button size="sm" icon="copy" onClick={() => void copy()}>
          Copy link
        </Button>
        {/* Publishing again, who may open it and Unpublish are an editor's; a viewer opens the page and copies its link. */}
        {canEdit && (
          <>
            <Button size="sm" icon="refresh" onClick={onRepublish}>
              Publish again
            </Button>
            <Menu
              label={`${name} options`}
              align="end"
              trigger={<IconButton icon="more-horizontal" size="sm" label={`${name} options`} />}
              items={[
                { label: 'Open', icon: 'external-link', onSelect: () => window.open(url, '_blank', 'noopener,noreferrer') },
                // A signed embed in another site (docs/embed): only a link that holds a dashboard.
                ...(site.config.dashboardIds.length ? [{ label: 'Embed…', icon: 'code' as const, onSelect: onEmbed }] : []),
                site.access === 'link'
                  ? { label: 'Only your organisation', icon: 'lock', onSelect: () => access.mutate({ id: site.id, access: 'org' }, { onError: fail }) }
                  : { label: 'Anyone with the link', icon: 'globe', disabled: !publicLinks, onSelect: () => access.mutate({ id: site.id, access: 'link' }, { onError: fail }) },
                { kind: 'separator' },
                {
                  label: armed ? 'Unpublish — the link stops working' : 'Unpublish…',
                  icon: 'trash',
                  danger: true,
                  onSelect: () => {
                    if (!armed) {
                      setArmed(true);
                      toast(`Choose Unpublish again to take “${name}” down.`);
                      setTimeout(() => setArmed(false), 6000);
                      return;
                    }
                    unpublish.mutate(site.id, { onSuccess: () => toast('Unpublished'), onError: fail });
                  },
                },
              ]}
            />
          </>
        )}
      </div>
    </li>
  );
}

/** The new-dashboard wizard (the list's `?new=1`): what is published here is made there. */
function CreateDashboard({ projectId }: { projectId: string }) {
  return (
    <Link className={buttonClass('secondary')} to={`/dashboards?project=${projectId}&new=1`}>
      <Icon name="plus" />
      <span>Create dashboard</span>
    </Link>
  );
}

/** The published links (`&tab=links`), and Publish…. `preselect`: the dialog opens with that dashboard picked. */
function SharedLinks({ projectId, preselect, onClosePreselect }: { projectId: string; preselect?: string; onClosePreselect: () => void }) {
  const q = useSites(projectId);
  const canEdit = useCanEdit(projectId);
  const [dialog, setDialog] = useState<{ site?: HostedSite } | null>(() => (preselect ? {} : null));
  const [embed, setEmbed] = useState<HostedSite | null>(null);
  const close = () => {
    setDialog(null);
    if (preselect) onClosePreselect();
  };
  const publicLinks = q.data?.publicLinks ?? false;
  return (
    <>
      <div className={p.bar}>
        <span className={p.barNote}>
          <Icon name={publicLinks ? 'globe' : 'lock'} size={12} />
          {publicLinks ? 'Your organisation allows links anyone can open.' : 'Links open for people in your organisation only.'}
        </span>
        {canEdit && (
          <Button variant="primary" icon="globe" onClick={() => setDialog({})}>
            Publish…
          </Button>
        )}
      </div>
      {q.isPending ? (
        <SkeletonRows rows={4} label="Loading published links" />
      ) : q.isError ? (
        <ErrorState title="Published links could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !q.data.sites.length ? (
        <EmptyState
          icon="globe"
          title="Nothing published yet"
          actions={
            canEdit && (
              <>
                <CreateDashboard projectId={projectId} />
                <Button variant="primary" icon="globe" onClick={() => setDialog({})}>
                  Publish a dashboard
                </Button>
              </>
            )
          }
        >
          {canEdit
            ? 'Publishing turns dashboards into read-only pages at a link you can share — with their filter bars, built from the figures as they are when you publish.'
            : 'An editor of this project can publish its dashboards as read-only pages at a link. You have view-only access.'}
        </EmptyState>
      ) : (
        <ul className={p.sites} aria-label="Published links">
          {q.data.sites.map((site) => (
            <SiteRow key={site.id} site={site} projectId={projectId} publicLinks={publicLinks} canEdit={canEdit} onRepublish={() => setDialog({ site })} onEmbed={() => setEmbed(site)} />
          ))}
        </ul>
      )}
      {embed && canEdit && <EmbedDialog projectId={projectId} site={embed} onClose={() => setEmbed(null)} />}
      {dialog && canEdit && <PublishDialog projectId={projectId} site={dialog.site} preselect={preselect} publicLinks={publicLinks} onClose={close} onPublished={() => undefined} />}
    </>
  );
}

function Board({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const preselect = params.get('dashboard') ?? undefined;
  const canEdit = useCanEdit(projectId);
  const links = !!preselect || params.get('tab') === 'links';
  // Closing Publish opened on a dashboard stays on the published list.
  const dropPreselect = () =>
    setParams(
      (cur) => {
        const next = new URLSearchParams(cur);
        next.delete('dashboard');
        next.set('tab', 'links');
        return next;
      },
      { replace: true },
    );
  if (!links) return <DashboardList projectId={projectId} />;
  return (
    <Page title="Dashboards" sub="The links that share this project’s dashboards." actions={canEdit && <CreateDashboard projectId={projectId} />}>
      <SharedLinks projectId={projectId} preselect={preselect} onClosePreselect={dropPreselect} />
    </Page>
  );
}

export default function DashboardsPage() {
  return (
    <ProjectGate title="Dashboards" why="Dashboards belong to a project.">
      {(projectId) => <Board key={projectId} projectId={projectId} />}
    </ProjectGate>
  );
}
