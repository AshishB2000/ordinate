// A story's data for a published site — MAIN PROCESS.
//
// A story is a column of blocks, each already scoped by its own filters, so it
// has no filter bar and one answer per block. Same functions as a dashboard
// tile (./dashboardData.ts): `vizDataFor` for a visual, `resolveMetric` for a
// metric, the author's caption or the app's (`tileCaption`).

import * as stories from '../analysis/stories';
import * as visuals from '../analysis/visuals';
import { sanitizeEncoding } from '../analysis/visuals';
import { mergeDashboardFilters } from '../analysis/dashboardFilters';
import { tileCaption } from '../analysis/captions';
import { vizDataFor } from '../ipc/visuals';
import { resolveMetric } from '../ipc/metrics';
import { chartPayload } from './dashboardData';
import { withEvents } from '../ipc/events'; // r8:events
import type { BuildProgress, Outgoing } from './dashboardData';

export interface PublishedBlock {
  kind: 'text' | 'callout' | 'divider' | 'image' | 'chart' | 'metrics' | 'broken';
  text?: string;
  tone?: string;
  src?: string;
  alt?: string;
  caption?: string;
  title?: string;
  chartType?: string;
  data?: unknown;
  metrics?: Array<{ name: string; display: string; value: number | null }>;
  reason?: string;
}

export interface PublishedStory {
  id: string;
  name: string;
  blocks: PublishedBlock[];
  geoLevels: string[];
  boundaryIds: string[];
}

export async function buildStory(
  projectId: string,
  storyId: string,
  ctx: BuildProgress = {},
  outgoing?: Outgoing,
): Promise<PublishedStory | null> {
  const s = await stories.getStory(projectId, storyId);
  if (!s) return null;
  const geoLevels = new Set<string>();
  const boundaryIds = new Set<string>();
  const blocks: PublishedBlock[] = [];
  let i = 0;
  for (const b of s.blocks) {
    if (ctx.checkCancelled) ctx.checkCancelled();
    i++;
    if (ctx.progress) ctx.progress(i / Math.max(1, s.blocks.length), `Block ${i} of ${s.blocks.length}`);
    if (b.kind === 'text') { blocks.push({ kind: 'text', text: b.text }); continue; }
    if (b.kind === 'callout') { blocks.push({ kind: 'callout', tone: b.tone, text: b.text }); continue; }
    if (b.kind === 'divider') { blocks.push({ kind: 'divider' }); continue; }
    if (b.kind === 'image') { blocks.push({ kind: 'image', src: b.src, alt: b.alt, caption: b.caption }); continue; }
    if (b.kind === 'visual') {
      const v = await visuals.getVisual(projectId, b.visualId);
      if (!v) { blocks.push({ kind: 'broken', reason: 'This visual was deleted.' }); continue; }
      const enc = sanitizeEncoding(v.encoding);
      if (enc.geo) {
        if (enc.geo.level === 'custom' && enc.geo.boundaryId) boundaryIds.add(enc.geo.boundaryId);
        else geoLevels.add(enc.geo.level);
      }
      const blockFilters = mergeDashboardFilters(b.filters, v.filters);
      const reply = await withEvents(await vizDataFor(projectId, v.datasetId, enc, blockFilters), projectId, v.datasetId, blockFilters); // r8:events
      if (!reply.ok) { blocks.push({ kind: 'broken', reason: reply.error }); continue; }
      const data = await chartPayload(v.datasetId, enc, v.chartType || 'column', v.overrides, reply.data, outgoing);
      if (typeof data.hidden === 'string') { blocks.push({ kind: 'broken', reason: data.hidden }); continue; }
      blocks.push({
        kind: 'chart', title: v.name, chartType: v.chartType || 'column', data,
        // The author's caption wins; otherwise the app's, written from what is shown.
        caption: b.caption || String(data.caption || ''),
      });
      continue;
    }
    // metric / metrics_row: the saved metrics, under the block's filters.
    const ids = b.kind === 'metric' ? [b.metricId] : b.metricIds;
    const metrics: PublishedBlock['metrics'] = [];
    for (const id of ids) {
      const r = await resolveMetric(projectId, id, { filters: b.filters });
      if (r && r.ok) metrics.push({ name: r.name, display: r.display, value: r.value });
    }
    if (!metrics.length) { blocks.push({ kind: 'broken', reason: 'This metric was deleted.' }); continue; }
    blocks.push({
      kind: 'metrics', metrics,
      caption: b.kind === 'metric' && b.caption ? b.caption : tileCaption({ kpis: metrics.map((m) => ({ label: m.name, value: m.value })) }),
    });
  }
  return { id: s.id, name: s.name, blocks, geoLevels: [...geoLevels], boundaryIds: [...boundaryIds] };
}
