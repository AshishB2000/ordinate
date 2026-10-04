// Home's "What stands out" row (insights.ts insRenderHome): the project's
// strongest findings that have a chart, at most six, each with its sparkline.
// They ride Home's own `home:overview` reply (src/ipc/insights.ts standsOut),
// the query Home already makes, so the row costs no round trip of its own
// (plan §9). NO EMPTY STATE — with nothing to say the row does not render at
// all (Home already has a greeting, an ask bar and two full columns). While it
// loads it holds its place with a skeleton so the columns below do not jump.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useOverview } from '../../../api/home';
import type { ChartDataShape } from '../../../charts/types';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { openDockWith } from '../../assistant/dockState';
import { saveVisual } from '../../visuals/api';
import { useDismiss, type Insight } from './api';
import { InsightCard, sparkKey } from './InsightCard';
import s from './Insights.module.css';

type Card = Insight & { spark: ChartDataShape | null };

export function WhatStandsOut({ projectId }: { projectId: string | undefined }) {
  const q = useOverview(projectId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dismiss = useDismiss(projectId ?? '');
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  if (!projectId) return null;
  if (q.isPending) {
    return (
      <section className={s.home} aria-label="What stands out" aria-busy="true">
        <h2 className={s.homeH}>What stands out</h2>
        <div className={s.row}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className={s.cardSk} />
          ))}
        </div>
      </section>
    );
  }
  const list = ((q.data?.standsOut ?? []) as unknown as Card[]).filter((i) => i.chart && !gone.has(i.id));
  if (!list.length) return null;
  // Each card's sparkline arrived with the overview: it seeds the card's own chart query, which then asks nothing.
  for (const ins of list) {
    const key = sparkKey(projectId, ins.id);
    if (ins.spark && !qc.getQueryData(key)) qc.setQueryData(key, { ok: true, data: ins.spark });
  }

  // The chart the card claims, as a real Visual — its filters travel with it: a mover's chart is ABOUT one category.
  const save = async (ins: Insight) => {
    try {
      const v = await saveVisual({
        projectId,
        datasetId: ins.datasetId,
        name: String(ins.title || 'Insight').slice(0, 80),
        chartType: ins.chart?.type || 'line',
        encoding: ins.chart!.encoding,
        overrides: {},
        filters: (ins.chart?.filters ?? []) as never,
      });
      toast(`Saved “${v.name}” to Visuals.`, { kind: 'success', action: { label: 'Open', onClick: () => void navigate(`/visuals/${projectId}/${v.id}`) } });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save that visual.', { kind: 'error' });
    }
  };
  // On the dataset, so the dock's context is the data the finding is about (the desktop opened it first).
  const askWhy = (ins: Insight) => {
    void navigate(`/data/${projectId}/${ins.datasetId}`);
    openDockWith(`Why: ${ins.title}`);
  };
  return (
    <section className={s.home} aria-label="What stands out">
      <h2 className={s.homeH}>What stands out</h2>
      <div className={s.row}>
        {list.map((ins) => (
          <InsightCard
            key={ins.id}
            projectId={projectId}
            ins={ins}
            onDismiss={async (id) => {
              await dismiss(id);
              setGone((g) => new Set(g).add(id));
            }}
            actions={[
              { label: 'Save as visual', primary: true, run: save },
              { label: 'Ask why', run: askWhy },
            ]}
          />
        ))}
      </div>
    </section>
  );
}
