// What a screen shows where a feature is off for a Live dataset (docs/live-data/
// 00-plan.md L2.6): the reason, and "Make a copy" — a NEW extract of the same
// source (`dataset:copyLive`), the Live dataset left as it is. Three shapes:
//
//   <LiveOff feature>         a tab or a panel: the feature's own words
//   <LiveOffPage feature>     a route (prepare, a workbench): the same, as a page
//   <LiveRefusal message>     any figure the server refused, typed (./refusal.ts):
//                             the SERVER's sentence, compact, for a card or a tile
//
// None of them calls a row-reading channel: the gate decides from what the
// dataset list or header already said (`mode: 'live'`), so a Live dataset's
// screens never meet the refusal at all.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { rpc } from '../../api/client';
import { useDatasets } from '../../api/datasets';
import { Page } from '../../app/blocks';
import { Button, buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { EmptyState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { rowsText } from '../data/format';
import { useCan } from '../projects/api';
import { LIVE_OFF, type LiveOffFeature } from './offFeatures';
import s from './Live.module.css';

type CopyReply = { ok: true; dataset: { id: string; name: string; rowCount: number }; warnings?: string[] } | { ok: false; error?: string; code?: string };

/** What a fresh copy changes on screen. */
const REFRESH = ['dataset:list', 'catalog:list', 'lineage:get', 'catalog:tags'] as const;

/**
 * "Make a copy": the server imports the Live dataset's selection as a new
 * extract. With `open`, the person is taken to the copy (where they were
 * going); without, the toast carries "Open".
 */
export function useMakeCopy(projectId: string, datasetId: string, open?: (copyId: string) => string) {
  const client = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async () => (await rpc('dataset:copyLive', { projectId, datasetId })) as CopyReply,
    onSuccess: (r) => {
      if (!r.ok) {
        toast(r.error || 'The copy could not be made.', { kind: 'error' });
        return;
      }
      for (const key of REFRESH) void client.invalidateQueries({ queryKey: [key] });
      const what = `Copied into “${r.dataset.name}” — ${rowsText(r.dataset.rowCount)}. The Live dataset is unchanged.`;
      if (open) {
        void navigate(open(r.dataset.id));
        toast(what, { kind: 'success' });
      } else {
        toast(what, { kind: 'success', action: { label: 'Open', onClick: () => void navigate(`/data/${projectId}/${r.dataset.id}`) } });
      }
    },
    onError: (err) => toast(`The copy did not go through: ${err.message}`, { kind: 'error' }),
  });
}

/** The action itself; an editor's (it saves a dataset), so a viewer is told who can. */
export function MakeCopyButton({ projectId, datasetId, open, variant = 'primary', size }: {
  projectId: string;
  datasetId: string;
  open?: (copyId: string) => string;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}) {
  const copy = useMakeCopy(projectId, datasetId, open);
  const can = useCan(projectId);
  const allowed = can('editor');
  return (
    <Button
      variant={variant}
      size={size}
      icon="copy"
      loading={copy.isPending}
      disabled={!allowed}
      title={allowed ? 'Import the same source as a new dataset that keeps its rows here. This Live dataset stays as it is.' : 'An editor of this project can make a copy.'}
      onClick={() => copy.mutate()}
    >
      Make a copy
    </Button>
  );
}

/** A tab or a panel: this feature is off for Live — why, and the copy that has it. */
export function LiveOff({ projectId, datasetId, feature, heading = 2, compact }: {
  projectId: string;
  datasetId: string;
  feature: LiveOffFeature;
  heading?: 2 | 3;
  compact?: boolean;
}) {
  const words = LIVE_OFF[feature];
  return (
    <div className={s.off} data-live-off={feature}>
      <EmptyState
        icon="zap"
        heading={heading}
        compact={compact}
        title={words.title}
        actions={<MakeCopyButton projectId={projectId} datasetId={datasetId} open={(id) => words.open(projectId, id)} size={compact ? 'sm' : 'md'} />}
      >
        {`${words.why} Make a copy to use it — the copy keeps its rows here and refreshes on a schedule; this Live dataset stays as it is.`}
      </EmptyState>
    </div>
  );
}

/** A route over a Live dataset (prepare, a workbench): the page's title, the dataset's way back, and <LiveOff>. */
export function LiveOffPage({ title, projectId, datasetId, feature }: { title: string; projectId: string; datasetId: string; feature: LiveOffFeature }) {
  return (
    <Page title={title}>
      <div className={s.pageBack}>
        <Link className={buttonClass('ghost', 'sm')} to={`/data/${projectId}/${datasetId}`}>
          <Icon name="arrow-left" />
          <span>Back to the dataset</span>
        </Link>
      </div>
      <LiveOff projectId={projectId} datasetId={datasetId} feature={feature} />
    </Page>
  );
}

/**
 * A figure the server refused because its dataset is Live: the server's own
 * sentence, and — when the dataset is known — "Make a copy". Compact, for a
 * dashboard tile, a KPI card, an answer card or the builder's stage.
 */
export function LiveRefusal({ message, projectId, datasetId, title = 'Off for this Live dataset' }: {
  message: string;
  projectId: string;
  datasetId?: string;
  title?: string;
}) {
  return (
    <div className={s.refusal} data-live-refusal="">
      <EmptyState
        compact
        heading={3}
        icon="zap"
        title={title}
        actions={datasetId ? <MakeCopyButton projectId={projectId} datasetId={datasetId} variant="secondary" size="sm" /> : undefined}
      >
        {message}
      </EmptyState>
    </div>
  );
}

/** One line above tools that read rows, where a Live dataset is the one picked: why they need a copy, and the copy. */
export function LiveBanner({ projectId, datasetId, name }: { projectId: string; datasetId: string; name: string }) {
  return (
    <div className={s.banner} role="note" data-live-banner="">
      <Icon name="zap" size={16} />
      <p>{`“${name}” is Live: its rows stay in the warehouse. Charts, KPI tiles and answers ask it directly; the tools below read rows, so each works on a copy.`}</p>
      <MakeCopyButton projectId={projectId} datasetId={datasetId} size="sm" variant="secondary" />
    </div>
  );
}

/**
 * Is this dataset Live? From the project's dataset list (one cached read every
 * Data screen already makes), so a gate costs no request of its own and never
 * calls the channel it guards. `pending` until the list has answered.
 */
export function useIsLive(projectId: string | undefined, datasetId: string | undefined): { pending: boolean; live: boolean } {
  const list = useDatasets(projectId);
  if (!projectId || !datasetId) return { pending: false, live: false };
  if (list.isPending) return { pending: true, live: false };
  return { pending: false, live: !!list.data?.some((d) => d.id === datasetId && d.mode === 'live') };
}
