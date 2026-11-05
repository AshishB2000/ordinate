// Which join a chart goes through when two datasets are joined more than one way (semantic step 09): a chart
// that names no join takes the FIRST relationship between its tables in `relationship:list` order (the
// planner's `reachable`, src/analysis/joinPlan.ts), and a re-save keeps that order. Said under the
// Relationships list, one line per pair of tables; nothing when every pair has one join.

import { useDatasets } from '../../../api/datasets';
import { Icon } from '../../../ui/icons/Icon';
import { useRelationships, type Relationship } from '../../data/api';
import s from '../Model.module.css';

/** "Charts use Order date unless they pick Ship date." for each many → one pair with two or more relationships. */
export function defaultJoinLines(rels: readonly Relationship[], name: (id: string) => string): string[] {
  const byPair = new Map<string, Relationship[]>();
  for (const r of rels) {
    const key = `${r.from.datasetId}\u0000${r.to.datasetId}`;
    byPair.set(key, [...(byPair.get(key) ?? []), r]);
  }
  // Step 09's own fallback name for a join with no label.
  const called = (r: Relationship) => r.label || `${name(r.to.datasetId)} (${r.from.column})`;
  return [...byPair.values()].filter((g) => g.length > 1).map(([first, ...rest]) => `Charts use ${called(first)} unless they pick ${rest.map(called).join(' or ')}.`);
}

export function DefaultJoins({ projectId }: { projectId: string }) {
  const rels = useRelationships(projectId);
  const ds = useDatasets(projectId);
  if (!rels.data || !ds.data) return null; // RelationshipsTab above draws the loading and error states of the same reads
  const datasets = ds.data;
  const lines = defaultJoinLines(rels.data, (id) => datasets.find((d) => d.id === id)?.name ?? 'A missing dataset');
  if (!lines.length) return null;
  return (
    <div role="note" aria-label="Which join charts use">
      <ul className={s.joins}>
        {lines.map((line) => (
          <li key={line}>
            <Icon name="link" size={16} />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
