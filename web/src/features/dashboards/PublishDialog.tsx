// Publish (legacy publishDialog.ts, "Publish to folder" → publish to a URL):
// what to publish (dashboards, stories, scorecards), the site's title, how many
// filter-bar combinations each dashboard pre-computes, who may open the link,
// and a live size estimate from the server against the 50 MB limit. The
// server builds the pages (the same builders, Share policy and whitelist as the
// desktop's folder) and serves them at /p/<id>/.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { brandTokens, CHART_PALETTE } from '../../charts/palette';
import { Button } from '../../ui/Button';
import { Checkbox, RadioGroup } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { reason, siteUrl, usePublishActions, useTargets, type Access, type HostedSite, type Plan, type Targets } from './api';
import p from './Publish.module.css';

const COMBOS = [32, 64, 128, 256, 512, 1024];
const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

type Kind = 'dashboardIds' | 'storyIds' | 'scorecardIds';

/** brand.ts brandExportRamp: a dashboard's custom accent (or the workspace's, on the default blue) as the export ramp. */
export function brandsFor(list: Targets['dashboards'], picked: string[], workspaceAccent: string): Record<string, { ramp: Record<string, unknown> }> {
  const out: Record<string, { ramp: Record<string, unknown> }> = {};
  for (const d of list) {
    if (!picked.includes(d.id) || !d.style) continue;
    const hex = d.style.accentHex || (d.style.accent === 'blue' ? workspaceAccent : '');
    const t = hex ? brandTokens(hex) : null;
    if (!t) continue;
    const dark = d.style.theme === 'dark';
    const v = dark ? t.dark : t.light;
    const k = dark ? '--brand-dk-' : '--brand-';
    out[d.id] = { ramp: { accent: v[k + 'accent'], accent2: v[k + 'accent-2'], soft: v[k + 'accent-soft'], line: v[k + 'accent-line'], chart: CHART_PALETTE.map((_c, i) => v[`${k}chart-${i + 1}`]) } };
  }
  return out;
}

function Group({ title, empty, items, picked, onChange }: { title: string; empty: string; items: { id: string; name: string; sheets?: number }[]; picked: string[]; onChange: (ids: string[]) => void }) {
  const all = items.length > 0 && items.every((i) => picked.includes(i.id));
  return (
    <fieldset className={p.group}>
      <legend className={p.groupTitle}>
        {title}
        {items.length > 1 && (
          <button type="button" className={p.selectAll} onClick={() => onChange(all ? [] : items.map((i) => i.id))}>
            {all ? 'Select none' : 'Select all'}
          </button>
        )}
      </legend>
      {items.length === 0 ? (
        <p className={p.empty}>{empty}</p>
      ) : (
        items.map((i) => (
          <Checkbox
            key={i.id}
            label={i.name}
            hint={i.sheets && i.sheets > 1 ? `${i.sheets} sheets` : undefined}
            checked={picked.includes(i.id)}
            onCheckedChange={(on) => onChange(on ? [...picked, i.id] : picked.filter((x) => x !== i.id))}
          />
        ))
      )}
    </fieldset>
  );
}

export function PublishDialog({
  projectId,
  site,
  preselect,
  publicLinks,
  onClose,
  onPublished,
}: {
  projectId: string;
  /** Re-publish settings for this site (its link stays). */
  site?: HostedSite;
  preselect?: string;
  publicLinks: boolean;
  onClose: () => void;
  onPublished: (s: HostedSite) => void;
}) {
  const targets = useTargets(projectId, true);
  const { run } = usePublishActions(projectId);
  const [picks, setPicks] = useState<Record<Kind, string[]>>(() => ({
    dashboardIds: site?.config.dashboardIds ?? (preselect ? [preselect] : []),
    storyIds: site?.config.storyIds ?? [],
    scorecardIds: site?.config.scorecardIds ?? [],
  }));
  const [title, setTitle] = useState(site?.config.options.title ?? '');
  const [combos, setCombos] = useState(String(site?.config.options.maxCombos ?? 256));
  const [access, setAccess] = useState<Access>(site?.access ?? 'org');
  const [afterRefresh, setAfterRefresh] = useState(site?.config.options.afterRefresh === true);
  const client = useQueryClient();
  const [plan, setPlan] = useState<{ busy: boolean; plan?: Plan; error?: string }>({ busy: false });
  const seq = useRef(0);

  // Nothing picked yet and no preselect: the first dashboard, as the desktop dialog opens.
  useEffect(() => {
    const first = targets.data?.dashboards[0]?.id;
    if (first && !site && !preselect) setPicks((cur) => (cur.dashboardIds.length + cur.storyIds.length + cur.scorecardIds.length ? cur : { ...cur, dashboardIds: [first] }));
  }, [targets.data, site, preselect]);

  const config = {
    projectId,
    ...picks,
    options: { maxCombos: Number(combos), ...(title.trim() ? { title: title.trim() } : {}), ...(afterRefresh ? { afterRefresh: true } : {}) },
  };
  const count = picks.dashboardIds.length + picks.storyIds.length + picks.scorecardIds.length;
  const key = JSON.stringify(config);
  // The live estimate, debounced; a stale reply is dropped (publishDialog.ts pdReplan).
  useEffect(() => {
    if (!count) return setPlan({ busy: false });
    const my = ++seq.current;
    setPlan((cur) => ({ ...cur, busy: true }));
    const t = setTimeout(() => {
      rpc('publish:plan', JSON.parse(key) as typeof config).then(
        (r) => {
          if (my !== seq.current) return;
          const res = r as { ok: boolean; plan?: Plan; error?: string };
          setPlan(res.ok ? { busy: false, plan: res.plan } : { busy: false, error: res.error || 'Could not size the site.' });
        },
        (err: unknown) => my === seq.current && setPlan({ busy: false, error: reason(err, 'Could not size the site.') }),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [key, count]);

  const publish = () => {
    // Each picked dashboard's accent as the brand ramp, so the page paints as the sheet does (pdBrands).
    const ws = (client.getQueryData(['prefs:get']) as { branding?: { accent?: unknown } } | null | undefined)?.branding?.accent;
    const brands = brandsFor(targets.data?.dashboards ?? [], picks.dashboardIds, typeof ws === 'string' ? ws : '');
    run.mutate(
      { ...config, access, ...(Object.keys(brands).length ? { brands } : {}), ...(site ? { id: site.id } : {}) },
      {
        onSuccess: (r) => {
          toast(site ? 'Re-published' : 'Published', { kind: 'success', action: { label: 'Copy link', onClick: () => void navigator.clipboard.writeText(siteUrl(r.site.id)) } });
          onPublished(r.site);
          onClose();
        },
        onError: (e) => toast(reason(e, 'Publishing failed.'), { kind: 'error' }),
      },
    );
  };

  const pl = plan.plan;
  const ready = !!pl && !pl.tooBig && count > 0 && !plan.busy;
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={site ? 'Publish again' : 'Publish'}
      description="A read-only page the server keeps at its own link. It shows the figures as they are when you publish — publish again to update them."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" icon="globe" disabled={!ready} loading={run.isPending} onClick={publish}>
            {site ? 'Publish again' : 'Publish'}
          </Button>
        </>
      }
    >
      {targets.isPending ? (
        <SkeletonRows rows={5} label="Loading what can be published" />
      ) : targets.isError ? (
        <ErrorState compact heading={3} title="Could not open publish" message={targets.error.message} onRetry={() => void targets.refetch()} />
      ) : (
        <div className={p.cols}>
          <div className={p.col}>
            <h3 className={p.colTitle}>What to publish</h3>
            <Group title="Dashboards" empty="No dashboards in this project yet." items={targets.data.dashboards} picked={picks.dashboardIds} onChange={(ids) => setPicks({ ...picks, dashboardIds: ids })} />
            <Group title="Stories" empty="No stories in this project yet." items={targets.data.stories} picked={picks.storyIds} onChange={(ids) => setPicks({ ...picks, storyIds: ids })} />
            <Group title="Scorecards" empty="No scorecards in this project yet." items={targets.data.scorecards} picked={picks.scorecardIds} onChange={(ids) => setPicks({ ...picks, scorecardIds: ids })} />
          </div>
          <div className={p.col}>
            <h3 className={p.colTitle}>Who and how</h3>
            <RadioGroup
              label="Who can open the link"
              value={access}
              onValueChange={(v) => setAccess(v as Access)}
              options={[
                { value: 'org', label: 'People in your organisation', hint: 'They sign in to open it.' },
                {
                  value: 'link',
                  label: 'Anyone with the link',
                  hint: publicLinks ? 'No sign-in. Only what you publish is on the page.' : 'Your organisation has not turned public links on — an admin can, in Admin → Settings.',
                  disabled: !publicLinks,
                },
              ]}
            />
            <Input label="Site title" placeholder="The project’s name" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            <Select
              label="Filter-bar combinations"
              hint="Each state of a dashboard’s filter bar is computed now and stored with the page."
              value={combos}
              onValueChange={setCombos}
              options={COMBOS.map((n) => ({ value: String(n), label: `Up to ${n} per dashboard` }))}
            />
            <Checkbox
              label="Re-publish after data refreshes"
              hint="When a dataset this site reads refreshes, the server rebuilds it at the same link."
              checked={afterRefresh}
              onCheckedChange={setAfterRefresh}
            />
            <div className={p.plan} aria-live="polite">
              {!count ? (
                <p className={p.empty}>Pick at least one dashboard, story or scorecard.</p>
              ) : plan.error ? (
                <p className={p.bad}>
                  <Icon name="alert" size={12} /> {plan.error}
                </p>
              ) : !pl ? (
                <SkeletonRows rows={2} label="Sizing the site" />
              ) : (
                <div className={plan.busy ? p.stale : undefined}>
                  <p className={p.summary}>{pl.summary}</p>
                  <meter className={p.meter} min={0} max={pl.maxBytes} value={pl.bytes} aria-label={`Size against the ${mb(pl.maxBytes)} limit`} />
                  <ul className={p.pages}>
                    {pl.pages.map((pg) => (
                      <li key={pg.id}>
                        <span className={p.pageName}>{pg.name}</span>
                        <span className={p.pageMeta}>
                          {pg.kind === 'dashboard' ? (pg.combos > 1 ? `${pg.combos} combinations` : 'No filter bar') : pg.kind === 'story' ? 'Story' : 'Scorecard'}
                          {pg.mode === 'single' ? ' · one filter at a time' : ''} · {mb(pg.bytes)}
                        </span>
                        {pg.dropped.map((d) => (
                          <span key={d.control} className={p.dropped}>
                            “{d.control}” keeps its first options; {d.options.length} left out.
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                  {pl.tooBig && (
                    <div className={p.bad}>
                      Over the {mb(pl.maxBytes)} limit. To fit:
                      <ul>
                        {pl.suggestions.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
