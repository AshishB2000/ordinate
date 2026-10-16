// A published link's Embed… (docs/embed/00-design.md): how to show one of its
// dashboards inside another site. The embed URL pattern, the claims a token
// carries for it, the locked filters (the columns its tiles read), theme and
// hide; the signing code filled in with all of it, and a live preview the
// server signs for ten minutes. Signing for real is the host's BACKEND, with
// the org's secret (Admin → Embedding) — nothing here can mint a working link.

import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { useMe } from '../auth/api';
import { paramsOf, useEmbedStatus, type EmbedStatus } from '../embed/api';
import { EmbedOptions, NO_CHOICE, useLockColumns, type EmbedChoice } from '../embed/EmbedOptions';
import { EmbedPreview } from '../embed/EmbedPreview';
import { copy, EmbedSnippets } from '../embed/EmbedSnippets';
import { claimsOf, pretty } from '../embed/snippets';
import { useTargets, type HostedSite } from './api';
import a from '../admin/Admin.module.css';
import s from '../embed/Embed.module.css';

function Off({ status }: { status: EmbedStatus }) {
  const me = useMe();
  const admin = me.data?.user?.role === 'admin';
  const where = admin ? <Link to="/admin?tab=embedding">Admin → Embedding</Link> : 'Admin → Embedding';
  if (status.enabled) return null;
  return (
    <div className={a.notice} role="note">
      <Icon name="lock" />
      <div>
        <h3 className={a.noticeTitle}>{status.secretSet ? 'Embedding is off for your organisation' : 'Embedding is not set up yet'}</h3>
        <p className={a.lead}>
          A signed link is refused until an organisation admin turns embedding on and allows the host site, in {where}. You can set the embed up and preview it now.
        </p>
      </div>
    </div>
  );
}

function Body({ projectId, site, status }: { projectId: string; site: HostedSite; status: EmbedStatus }) {
  const targets = useTargets(projectId, true);
  const [dashId, setDashId] = useState<string>(site.config.dashboardIds[0]);
  const [choice, setChoice] = useState<EmbedChoice>(NO_CHOICE);
  const [tab, setTab] = useState('preview');
  const { query, columns } = useLockColumns(projectId, site.id, dashId);
  const names = new Map((targets.data?.dashboards ?? []).map((d) => [d.id, d.name]));
  const params = paramsOf(choice.locks, columns);
  const input = {
    server: window.location.origin, org: status.org, pub: site.id, dash: dashId, params,
    ...(choice.theme ? { theme: choice.theme } : {}), hide: choice.hide,
  };
  const claims = pretty({ ...claimsOf(input), exp: '<now + 10 minutes, in seconds>' }, 2);
  const pattern = `${window.location.origin}/embed/`;
  return (
    <div className={s.stack}>
      <Off status={status} />
      <div className={s.dialogCols}>
        <div className={s.col}>
          {site.config.dashboardIds.length > 1 && (
            <Select label="Dashboard" value={dashId} onValueChange={(v) => { setDashId(v); setChoice(NO_CHOICE); }}
              options={site.config.dashboardIds.map((id) => ({ value: id, label: names.get(id) ?? 'Dashboard' }))} />
          )}
          <section className={s.stack} aria-label="Embed URL">
            <h4 className={s.sectionTitle}>Embed URL</h4>
            <div className={s.url}>
              <span>
                {pattern}
                <em>&lt;token signed by your backend&gt;</em>
              </span>
              <Button size="sm" variant="ghost" icon="copy" onClick={() => copy(pattern, 'The URL pattern')} aria-label="Copy the URL pattern">
                Copy
              </Button>
            </div>
            <p className={s.lead}>
              Put it in an <code>&lt;iframe&gt;</code> on an allowed site. The token is a JWT (HS256, <code>kid</code> = <code>{status.org}</code>) whose claims are:
            </p>
            <pre className={s.snippet} data-testid="embed-claims">
              {claims}
            </pre>
          </section>
          <EmbedOptions query={query} value={choice} onChange={setChoice} />
        </div>
        <div className={s.col}>
          <Tabs value={tab} onValueChange={setTab}>
            <TabList label="Embed">
              <Tab value="preview" icon="eye">
                Preview
              </Tab>
              <Tab value="code" icon="code">
                Signing code
              </Tab>
            </TabList>
            <TabPanel value="preview">
              <div className={s.stack}>
                <EmbedPreview
                  host={status.origins[0] ? `${status.origins[0]}/…` : 'https://your-portal.example/…'}
                  target={status.secretSet ? { projectId, siteId: site.id, dashboardId: dashId, params, ...(choice.theme ? { theme: choice.theme } : {}), hide: choice.hide } : null}
                />
                {!status.secretSet && <p className={s.previewMeta}>A preview is signed with the organisation’s secret — an admin generates it in Admin → Embedding.</p>}
              </div>
            </TabPanel>
            <TabPanel value="code">
              <p className={s.lead}>
                Run on your server for every page view. The values of a lock come from the signed-in user’s session — never from the browser.
              </p>
              <EmbedSnippets input={input} />
            </TabPanel>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

export function EmbedDialog({ projectId, site, onClose }: { projectId: string; site: HostedSite; onClose: () => void }) {
  const status = useEmbedStatus();
  const name = site.title || site.pages.map((x) => x.name).join(', ') || 'Published link';
  return (
    <Dialog
      open
      size="xxl"
      onOpenChange={(o) => !o && onClose()}
      title={`Embed · ${name}`}
      description="Show this dashboard inside your portal or app, with filters locked to each viewer’s rows."
      footer={
        <DialogClose asChild>
          <Button>Done</Button>
        </DialogClose>
      }
    >
      {status.isPending ? (
        <SkeletonRows rows={6} label="Loading embedding" />
      ) : status.isError ? (
        <ErrorState compact heading={3} title="Embedding could not be loaded" message={status.error.message} onRetry={() => void status.refetch()} />
      ) : !status.data.canStore ? (
        <EmptyState heading={3} icon="lock" title="This server cannot embed yet">
          Embedding signs links with a secret the server keeps encrypted — that needs a database and ORDINATE_MASTER_KEY. Ask whoever runs the server to set them.
        </EmptyState>
      ) : (
        <Body projectId={projectId} site={site} status={status.data} />
      )}
    </Dialog>
  );
}
