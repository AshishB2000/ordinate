// Explore's drill: a click on a bar of a drillable chart asks the server for the steps behind it and the next level
// (`visual:drillDown`), then hands the drilled question to `onChange`, which Explore pushes onto the URL, so Back goes
// up. On a phone a tap offers the drill in a sheet instead. Nothing here computes a figure.

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { PHONE_QUERY } from '../../ui/Dialog';
import { toast } from '../../ui/Toast';
import { PointSheet } from '../dashboards/phone/PointSheet';
import { serverLabel } from '../analyses/VisualTile';
import type { Preview } from '../visuals/api';
import { DRILL_FAILED, drillableAxis, drillDown } from '../visuals/drill/drillApi';
import { markAt } from '../visuals/drill/mark';
import type { PanelMark } from '../visuals/facets/FacetGrid';
import { liveFilters } from '../visuals/filters/filterText';
import type { NavHierarchy } from '../../../../src/analysis/drillLevels.ts';
import type { DateGrain } from '../../../../src/analysis/categoryKey.ts';
import { questionTitle, type Question } from './spec';

export { drillableAxis };

export interface DrillProps {
  projectId: string;
  datasetId: string;
  question: Question;
  reply: Preview | undefined;
  chartType: string;
  hierarchies: readonly NavHierarchy[];
  ladder: readonly DateGrain[];
  onChange: (next: Question) => void;
  /** The drilled value's label, as the server named it for its crumb (`crumb.label`). */
  onLabel?: (column: string, value: string | number, label: string) => void;
}

export function useExploreDrill({ projectId, datasetId, question, reply, chartType, hierarchies, ladder, onChange, onLabel }: DrillProps): { onMark?: PanelMark; sheet: ReactNode } {
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
        else {
          onLabel?.(r.crumb.column, mark, r.crumb.label);
          onChange({ ...question, encoding: r.encoding, filters: [...question.filters, ...r.steps] });
        }
      } finally {
        busy.current = false;
      }
    },
    [projectId, datasetId, question, onChange, onLabel],
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
