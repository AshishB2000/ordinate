// The check screen: the screenshot on the left with each tile the model found
// outlined and numbered; on the right the dashboard that will be built — its
// dataset, name and sketch — then one card per tile. Every change re-asks
// `rebuild:match` (app code, no model), and the last answer stays on screen,
// dimmed, until the new one lands.

import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState, Page } from '../../../app/blocks';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { SkeletonRows } from '../../../ui/Skeleton';
import { Icon } from '../../../ui/icons/Icon';
import type { MatchReply, Override, Reading } from './api';
import { RebuildShot, type ShotTile } from './RebuildShot';
import { RebuildSketch } from './RebuildSketch';
import { RebuildTile } from './RebuildTile';
import s from './Rebuild.module.css';

const TOOL: Record<string, string> = { tableau: 'Tableau', power_bi: 'Power BI', looker: 'Looker', metabase: 'Metabase' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function RebuildCheck({
  projectId,
  shot,
  reading,
  match,
  overrides,
  lit,
  onLight,
  onChange,
  datasetPicker,
  name,
  onName,
  building,
  onCreate,
  onRestart,
  back,
}: {
  projectId: string;
  shot: string;
  reading: Reading;
  match: UseQueryResult<MatchReply>;
  overrides: Override[];
  lit: number | null;
  onLight: (id: number | null) => void;
  onChange: (next: Override) => void;
  datasetPicker: ReactNode;
  name: string;
  onName: (name: string) => void;
  building: boolean;
  onCreate: () => void;
  onRestart: () => void;
  back: ReactNode;
}) {
  const m = match.data?.ok ? match.data : null;
  const read = reading.tiles as (Reading['tiles'][number] & { id: number; box: ShotTile['box'] })[];
  const shotTiles: ShotTile[] = m ? m.tiles : read.map((t) => ({ id: t.id, box: t.box, title: t.title ?? '', status: 'reading' as const }));
  const count = (st: string) => (m ? m.tiles.filter((t) => t.status === st).length : 0);
  const [ready, needs, dropped] = [count('ready'), count('unmapped'), count('dropped')];
  const tool = TOOL[reading.tool];

  let body;
  if (match.isError) body = <ErrorState compact heading={3} title="The tiles could not be matched" message={match.error.message} onRetry={() => void match.refetch()} />;
  else if (match.data && !match.data.ok) body = <ErrorState compact heading={3} title="The tiles could not be matched" message={match.data.error} onRetry={() => void match.refetch()} />;
  else if (!m) body = <SkeletonRows rows={6} label="Matching the tiles to your columns" />;
  else {
    body = (
      <ol className={s.tiles} aria-label="Tiles" data-stale={match.isPlaceholderData || undefined}>
        {m.tiles.map((t) => (
          <li key={t.id}>
            <RebuildTile
              tile={t}
              columns={m.columns}
              projectId={projectId}
              override={overrides.find((o) => o.id === t.id)}
              lit={lit === t.id}
              onLight={onLight}
              onChange={onChange}
            />
          </li>
        ))}
      </ol>
    );
  }

  return (
    <Page title="Check the rebuild" sub="Each tile the model found, matched to your columns. Change any match, drop what you do not need, then create the dashboard.">
      <div className={s.bar}>
        {back}
        <span className={s.spacer} />
        <Button variant="ghost" size="sm" icon="camera" onClick={onRestart}>
          Another screenshot
        </Button>
      </div>
      <div className={s.layout}>
        <div className={s.left}>
          <section className={s.shotCard} aria-label="Screenshot">
            <div className={s.cardHead}>
              <h2 className={s.label}>{tool ? `${tool} dashboard` : 'Screenshot'}</h2>
              <span className={s.muted}>{plural(read.length, 'tile')} found</span>
            </div>
            <RebuildShot src={shot} tiles={shotTiles} lit={lit} onLight={onLight} />
            <ul className={s.key} aria-label="Outline key">
              <li data-status="ready">Ready</li>
              <li data-status="unmapped">Needs you</li>
              <li data-status="dropped">Dropped</li>
            </ul>
          </section>
        </div>
        <div className={s.right}>
          <section className={s.card} aria-label="The dashboard">
            <div className={s.summaryHead}>
              {datasetPicker}
              <Input label="Dashboard name" value={name} maxLength={200} onChange={(e) => onName(e.target.value)} />
            </div>
            <div className={s.summary} data-stale={match.isFetching || undefined}>
              {m ? <RebuildSketch layout={m.layout} lit={lit} onLight={onLight} /> : <div className={s.sketchSkel} />}
              <div className={s.counts}>
                <p className={s.countMain}>
                  <strong>{ready}</strong> of {plural(m ? m.tiles.length : read.length, 'tile')} ready
                </p>
                <div className={s.countChips}>
                  {needs > 0 && <Badge tone="warn">{needs} need you</Badge>}
                  {dropped > 0 && <Badge>{dropped} dropped</Badge>}
                  {m && m.controls > 0 && (
                    <Badge tone="accent" icon="filter">
                      {plural(m.controls, 'filter')} in the bar
                    </Badge>
                  )}
                </div>
                <p className={s.muted}>
                  <Icon name="sparkles" size={12} /> The model read the layout only. Every figure is computed from your data.
                </p>
              </div>
            </div>
            {m && m.dropped.length > 0 && (
              <ul className={s.dropped} aria-label="Left out">
                {m.dropped.map((d, i) => (
                  <li key={i}>{d.message}</li>
                ))}
              </ul>
            )}
            <div className={s.createRow}>
              {needs > 0 && <span className={s.muted}>Tiles that need you are left out until they are fixed.</span>}
              <span className={s.spacer} />
              <Button variant="primary" icon="layout-dashboard" loading={building} disabled={!m || ready === 0 || match.isFetching} onClick={onCreate}>
                Create dashboard
              </Button>
            </div>
          </section>
          {body}
        </div>
      </div>
    </Page>
  );
}
