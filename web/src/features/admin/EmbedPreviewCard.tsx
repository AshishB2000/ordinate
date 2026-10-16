// Admin → Embedding's "Preview embed": pick a project, one of its published
// links and a dashboard of it; lock, theme and hide as a host would; the
// server signs a ten-minute preview and the real /embed/… page renders below.

import { useState } from 'react';
import { Select } from '../../ui/Select';
import { Icon } from '../../ui/icons/Icon';
import { useSites, useTargets } from '../dashboards/api';
import { paramsOf } from '../embed/api';
import { EmbedOptions, NO_CHOICE, useLockColumns, type EmbedChoice } from '../embed/EmbedOptions';
import { EmbedPreview } from '../embed/EmbedPreview';
import { useAdminProjects } from './api';
import s from '../embed/Embed.module.css';

export function EmbedPreviewCard({ canPreview }: { canPreview: boolean }) {
  const projects = useAdminProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [dashId, setDashId] = useState<string | null>(null);
  const [choice, setChoice] = useState<EmbedChoice>(NO_CHOICE);
  const sites = useSites(projectId);
  const targets = useTargets(projectId ?? '', !!projectId);
  const site = sites.data?.sites.find((x) => x.id === siteId) ?? null;
  const names = new Map((targets.data?.dashboards ?? []).map((d) => [d.id, d.name]));
  const dashboards = (site?.config.dashboardIds ?? []).map((id) => ({ value: id, label: names.get(id) ?? 'Dashboard' }));
  const dash = dashId && dashboards.some((d) => d.value === dashId) ? dashId : (dashboards[0]?.value ?? null);
  const { query, columns } = useLockColumns(projectId ?? '', siteId ?? '', site ? dash : null);
  const target = canPreview && projectId && site && dash
    ? { projectId, siteId: site.id, dashboardId: dash, params: paramsOf(choice.locks, columns), ...(choice.theme ? { theme: choice.theme } : {}), hide: choice.hide }
    : null;
  const siteOptions = (sites.data?.sites ?? []).filter((x) => x.config.dashboardIds.length).map((x) => ({ value: x.id, label: x.title || x.pages.map((p) => p.name).join(', ') || 'Published link' }));
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>
          <Icon name="eye" size={16} /> Preview embed
        </h3>
      </div>
      <p className={s.lead}>
        Sign a ten-minute preview with the org’s secret and see exactly what a host page would show — before you turn embedding on.
        {!canPreview && ' Generate a signing secret first.'}
      </p>
      <div className={s.options}>
        <Select
          aria-label="Project"
          placeholder={projects.isPending ? 'Loading projects…' : 'Pick a project'}
          value={projectId}
          onValueChange={(v) => { setProjectId(v); setSiteId(null); setDashId(null); setChoice(NO_CHOICE); }}
          options={(projects.data ?? []).filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name }))}
          disabled={!canPreview}
        />
        <Select
          aria-label="Published link"
          placeholder={!projectId ? 'Then a published link' : sites.isPending ? 'Loading links…' : siteOptions.length ? 'Pick a published link' : 'Nothing published yet'}
          value={siteId}
          onValueChange={(v) => { setSiteId(v); setDashId(null); setChoice(NO_CHOICE); }}
          options={siteOptions}
          disabled={!projectId || !siteOptions.length}
        />
        {dashboards.length > 1 && <Select aria-label="Dashboard" value={dash} onValueChange={(v) => { setDashId(v); setChoice(NO_CHOICE); }} options={dashboards} />}
      </div>
      {site && dash && (
        <div className={s.dialogCols}>
          <div className={s.col}>
            <EmbedOptions query={query} value={choice} onChange={setChoice} />
          </div>
          <div className={s.col}>
            <EmbedPreview target={target} host="https://your-portal.example/…" />
          </div>
        </div>
      )}
    </div>
  );
}
