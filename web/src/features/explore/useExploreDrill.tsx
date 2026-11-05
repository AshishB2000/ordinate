// Explore's drill: a click on a bar of a drillable chart asks the server for the steps behind it and the next level
// (`visual:drillDown`), then hands the drilled question to `onChange`, which Explore pushes onto the URL, so Back goes
// up. On a phone a tap offers the drill in a sheet instead. Nothing here computes a figure.

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { PHONE_QUERY } from '../../ui/Dialog';
import { toast } from '../../ui/Toast';
import { PointSheet } from '../dashboards/phone/PointSheet';
import { serverLabel } from '../analyses/VisualTile';
import type { Encoding, Preview } from '../visuals/api';
import { DRILL_FAILED, drillDown } from '../visuals/drill/drillApi';
import { markAt } from '../visuals/drill/mark';
import type { PanelMark } from '../visuals/facets/FacetGrid';
import { liveFilters } from '../visuals/filters/filterText';
import { DRILL_CHART_TYPES, grainWord, nextGrain, nextLevel, type NavHierarchy } from '../../../../src/analysis/drillLevels.ts';
import type { DateGrain } from '../../../../src/analysis/categoryKey.ts';
import { questionTitle, type Question } from './spec';

/** What a drill would go to, in the words the sheet uses ("by state", "by month"), or null: the click stays inert. */
export function drillableAxis(a: {
  chartType: string;
  encoding: Encoding;
  category: Preview['category'];
  hierarchies: readonly NavHierarchy[];
  ladder: readonly DateGrain[];
}): { next: string; word: string } | null {
  if (!DRILL_CHART_TYPES.has(a.chartType)) return null;
  if (a.category?.kind === 'date') {
    const next = nextGrain(a.ladder, a.category.grain as DateGrain);
    return next ? { next, word: grainWord(next, a.ladder) } : null;
  }
  const down = nextLevel(a.hierarchies, a.encoding.category);
  return down ? { next: down.next, word: down.next } : null;
}

export interface DrillProps {
  projectId: string;
  datasetId: string;
  question: Question;
  reply: Preview | undefined;
  chartType: string;
  hierarchies: readonly NavHierarchy[];
  ladder: readonly DateGrain[];
  onChange: (next: Question) => void;
}

export function useExploreDrill({ projectId, datasetId, question, reply, chartType, hierarchies, ladder, onChange }: DrillProps): { onMark?: PanelMark; sheet: ReactNode } {
  const [offer, setOffer] = useState<{ mark: string | number; shown: string } | null>(null);
  const busy = useRef(false);
  const axis = reply ? drillableAxis({ chartType, encoding: question.encoding, category: reply.category, hierarchies, ladder }) : null;

  const run = useCallback(
    async (mark: string | number) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await drillDown({ projectId, datasetId, encoding: question.encoding, filters: liveFilters(question.filters), mark: { category: mark } });
        if (!r.ok) toast(DRILL_FAILED, { kind: 'error' });
        else if (!r.available) toast(r.reason);
        else onChange({ ...question, encoding: r.encoding, filters: [...question.filters, ...r.steps] });
      } finally {
        busy.current = false;
      }
    },
    [projectId, datasetId, question, onChange],
  );

  if (!axis || !reply) return { sheet: null };
  const onMark: PanelMark = (chart, e) => {
    const m = markAt(chart, e);
    if (!m) return;
    const mark = serverLabel(reply.data.labels, m.category, reply.data.valueLabels);
    if (window.matchMedia?.(PHONE_QUERY).matches) setOffer({ mark, shown: String(m.category) });
    else void run(mark);
  };
  const sheet = offer && (
    <PointSheet
      title={offer.shown}
      chart={questionTitle(question.encoding)}
      actions={[{ label: `Drill into ${offer.shown} · by ${axis.word}`, icon: 'arrow-down', run: () => void run(offer.mark) }]}
      onClose={() => setOffer(null)}
    />
  );
  return { onMark, sheet };
}
