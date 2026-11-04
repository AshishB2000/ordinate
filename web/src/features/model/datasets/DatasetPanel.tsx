// The picked dataset's panel on the Data model's Datasets tab: its name, role and description, its
// Details popover (description, tags, owner) and the way to the dataset itself.

import { Link } from 'react-router';
import type { DatasetSummary } from '../../../api/datasets';
import { Badge } from '../../../ui/Badge';
import { Button, buttonClass } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { RecordDetails } from '../../data/Details';
import type { ModelTable } from '../api';
import m from '../Model.module.css';

const ROLE_WORD = { fact: 'Fact', dimension: 'Dimension' } as const;

export function DatasetPanel({ projectId, dataset, table }: { projectId: string; dataset: DatasetSummary; table: ModelTable | undefined }) {
  const role = table?.role || '';
  const description = table?.description ?? '';
  return (
    <section className={m.panel} aria-label={`About ${dataset.name}`}>
      <div className={m.panelHead}>
        <div>
          <div className={m.panelTitle}>
            <h2>{dataset.name}</h2>
            {role ? <Badge tone={role === 'fact' ? 'neutral' : 'ok'}>{ROLE_WORD[role]}</Badge> : <Badge>Role not set</Badge>}
            {dataset.mode === 'live' && <Badge tone="accent">Live</Badge>}
          </div>
          <p className={description ? m.desc : `${m.desc} ${m.muted}`}>{description || 'No description yet'}</p>
        </div>
        <div className={m.panelActions}>
          <RecordDetails projectId={projectId} kind="dataset" id={dataset.id} name={dataset.name} trigger={<Button size="sm" icon="info">Details</Button>} />
          <Link className={buttonClass('ghost', 'sm')} to={`/data/${projectId}/${dataset.id}`}>
            <Icon name="external-link" size={16} />
            <span>Open dataset</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
