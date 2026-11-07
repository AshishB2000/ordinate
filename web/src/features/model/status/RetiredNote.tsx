// "Retired metric: Gross revenue", under a chart or KPI that still draws one. An editor can switch to the replacement.
// Reads the project's metric list (cached by every page that draws tiles): no request per tile.

import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { useMetricList, type MetricSummary } from '../../analyses/metrics/api';
import { replacementOf, retiredMeasures } from './switchTo';
import s from './Status.module.css';

export function RetiredNote({ projectId, metricIds, onSwitch }: { projectId: string; metricIds: (string | undefined)[]; onSwitch?: (index: number, replacement: MetricSummary) => void }) {
  const list = useMetricList(projectId);
  const hits = retiredMeasures({ values: metricIds.map((metricId) => ({ metricId })) }, list.data ?? []);
  if (!hits.length) return null;
  return (
    <div className={s.note} role="note">
      {hits.map(({ index, metric }) => {
        const to = replacementOf(metric, list.data ?? []);
        return (
          <span key={index} className={s.noteRow}>
            <Icon name="archive" size={12} />
            {`Retired metric: ${metric.name}`}
            {onSwitch && to && (
              <Button size="sm" variant="ghost" onClick={() => onSwitch(index, to)}>
                {`Switch to ${to.name}`}
              </Button>
            )}
          </span>
        );
      })}
    </div>
  );
}
