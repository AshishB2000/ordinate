// /data/metrics?project=<id> — the metrics list moved to the Data model's Metrics tab
// (web/src/features/model/metrics/MetricsTab.tsx). An old link or bookmark lands there with every
// other parameter it carried (`?tag=`), for the current project when it names none.

import { Navigate, useLocation } from 'react-router';
import { ProjectGate } from '../../import/ProjectGate';

/** `?project=P&tag=finance` → `?tab=metrics&tag=finance`: the project is in the path once it lands. */
function metricsTabSearch(search: string): string {
  const rest = new URLSearchParams(search);
  rest.delete('project');
  rest.delete('tab');
  return new URLSearchParams([['tab', 'metrics'], ...rest]).toString();
}

export default function MetricsPage() {
  const { search } = useLocation();
  return (
    <ProjectGate title="Metrics" why="Metrics belong to a project.">
      {(projectId) => <Navigate to={`/model/${projectId}?${metricsTabSearch(search)}`} replace />}
    </ProjectGate>
  );
}
