// /dashboards?project=<id> — what this project has PUBLISHED (T2.9): each
// link, what it holds, who may open it, who published it and when, and the
// way to open, copy, publish again, change access or take it down. Publish…
// opens the dialog; `&dashboard=<id>` (the authoring head's Publish…) opens it
// with that dashboard picked. The pages themselves are served by the server
// at /p/<id>/ — a snapshot, built by value when published.

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ErrorState, Page } from '../../app/blocks';
import { ago } from '../../app/when';
import { Button, IconButton } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { SkeletonRows } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { ProjectGate } from '../import/ProjectGate';
import { useCanEdit } from '../projects/api';
import { reason, siteUrl, usePublishActions, useSites, type HostedSite } from './api';
import { PublishDialog } from './PublishDialog';
import p from './Publish.module.css';

const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function SiteRow({ site, projectId, publicLinks, onRepublish, canEdit }: { site: HostedSite; projectId: string; publicLinks: boolean; onRepublish: () => void; canEdit: boolean }) {
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

function Published({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const preselect = params.get('dashboard') ?? undefined;
  const q = useSites(projectId);
  const canEdit = useCanEdit(projectId);
  const [dialog, setDialog] = useState<{ site?: HostedSite } | null>(() => (preselect ? {} : null));
  const close = () => {
    setDialog(null);
    if (preselect) {
      params.delete('dashboard');
      setParams(params, { replace: true });
    }
  };
  const publicLinks = q.data?.publicLinks ?? false;
  return (
    <Page title="Dashboards" sub="Published, read-only pages of this project’s dashboards, stories and scorecards.">
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
              <Button variant="primary" icon="globe" onClick={() => setDialog({})}>
                Publish a dashboard
              </Button>
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
            <SiteRow key={site.id} site={site} projectId={projectId} publicLinks={publicLinks} canEdit={canEdit} onRepublish={() => setDialog({ site })} />
          ))}
        </ul>
      )}
      {dialog && canEdit && <PublishDialog projectId={projectId} site={dialog.site} preselect={preselect} publicLinks={publicLinks} onClose={close} onPublished={() => undefined} />}
    </Page>
  );
}

export default function DashboardsPage() {
  return (
    <ProjectGate title="Dashboards" why="Published dashboards belong to a project.">
      {(projectId) => <Published key={projectId} projectId={projectId} />}
    </ProjectGate>
  );
}
