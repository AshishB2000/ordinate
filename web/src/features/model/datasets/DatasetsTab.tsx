// The Data model's Datasets tab (the owner's pick, docs/semantic-layer/00-design.md): what to fill in
// next above a list of datasets grouped by role, and the picked dataset's panel beside it. The pick and
// the panel's tab are in the URL (?dataset=, ?panel=), so a link reopens them.

import { Link, useSearchParams } from 'react-router';
import { useDatasets, type DatasetSummary } from '../../../api/datasets';
import { Badge } from '../../../ui/Badge';
import { buttonClass } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonBlock, SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { useMe } from '../../auth/api';
import { useCanEdit } from '../../projects/api';
import { todoPanel, useModelOverview, type ModelTable, type TodoItem } from '../api';
import { DatasetPanel } from './DatasetPanel';
import { TodoStrip } from './TodoStrip';
import m from '../Model.module.css';

const GROUPS = [
  { role: 'fact', caption: 'Facts' },
  { role: 'dimension', caption: 'Dimensions' },
  { role: '', caption: 'Role not set' },
] as const;

/** The fiscal year is a workspace setting (Admin → Workspace): an org admin gets the way there. */
function CalendarLine() {
  const admin = useMe().data?.user?.role === 'admin';
  return (
    <p className={m.calendar}>
      <Icon name="calendar" size={16} />
      <span>Calendar and fiscal year are workspace settings.</span>
      {admin && <Link className={m.link} to="/admin?tab=workspace">Workspace settings</Link>}
    </p>
  );
}

function Loading() {
  return (
    <div className={m.split}>
      <div className={m.list}>
        <SkeletonRows rows={4} label="Loading the datasets" />
      </div>
      <div className={`${m.panel} ${m.panelLoading}`}>
        <SkeletonBlock label="Loading the data model" />
      </div>
    </div>
  );
}

function DatasetList({ list, tables, picked, hrefOf }: { list: DatasetSummary[]; tables: Map<string, ModelTable>; picked: string; hrefOf: (id: string) => string }) {
  return (
    <nav className={m.list} aria-label="Datasets">
      {GROUPS.map(({ role, caption }) => {
        const items = list.filter((d) => (tables.get(d.id)?.role ?? '') === role);
        if (!items.length) return null;
        const capId = `model-group-${role || 'none'}`;
        return (
          <div key={caption}>
            <span id={capId} className={m.groupCap}>
              {caption}
            </span>
            <ul className={m.group} aria-labelledby={capId}>
              {items.map((d) => {
                const on = d.id === picked;
                return (
                  <li key={d.id}>
                    <Link className={on ? `${m.item} ${m.itemOn}` : m.item} to={hrefOf(d.id)} replace aria-current={on ? 'true' : undefined}>
                      <span className={m.itemName}>
                        <Icon name={d.mode === 'live' ? 'cloud' : 'database'} size={16} />
                        <span>{d.name}</span>
                      </span>
                      {tables.get(d.id)?.keyState === 'repeats' && <Badge tone="warn">key repeats</Badge>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function DatasetsTab({ projectId }: { projectId: string }) {
  const list = useDatasets(projectId);
  const ov = useModelOverview(projectId);
  const canEdit = useCanEdit(projectId);
  const [params, setParams] = useSearchParams();

  const open = (item: TodoItem) =>
    setParams((p) => {
      const q = new URLSearchParams(p);
      q.set('dataset', item.datasetId);
      q.set('panel', todoPanel(item.kind));
      return q;
    }, { replace: true });
  const hrefOf = (id: string) => {
    const q = new URLSearchParams(params);
    q.set('dataset', id);
    return `?${q.toString()}`;
  };

  let body;
  if (list.isError || ov.isError) {
    body = (
      <ErrorState
        heading={3}
        title="The data model could not be loaded"
        message={(list.error ?? ov.error)?.message || 'Try again.'}
        onRetry={() => {
          void list.refetch();
          void ov.refetch();
        }}
      />
    );
  } else if (list.isPending || ov.isPending) {
    body = <Loading />;
  } else if (!list.data?.length) {
    body = (
      <EmptyState
        icon="database"
        heading={3}
        title="No datasets to describe yet"
        actions={
          canEdit && (
            <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
              Import file
            </Link>
          )
        }
      >
        {canEdit ? 'Import a file or connect a database, then say here what each dataset means.' : 'An editor of this project can bring data in.'}
      </EmptyState>
    );
  } else {
    const all = list.data;
    const tables = new Map(ov.data.tables.map((t) => [t.datasetId, t]));
    // The list's own order: Facts, then Dimensions, then the rest, each in dataset:list order.
    const shown = GROUPS.flatMap(({ role }) => all.filter((d) => (tables.get(d.id)?.role ?? '') === role));
    const dataset = shown.find((d) => d.id === params.get('dataset')) ?? shown[0];
    const names = new Map(all.map((d) => [d.id, d.name]));
    body = (
      <>
        {canEdit && <TodoStrip todo={ov.data.todo} more={ov.data.more} nameOf={(id) => names.get(id)} onOpen={open} />}
        <div className={m.split}>
          <DatasetList list={all} tables={tables} picked={dataset.id} hrefOf={hrefOf} />
          <DatasetPanel key={dataset.id} projectId={projectId} dataset={dataset} table={tables.get(dataset.id)} />
        </div>
      </>
    );
  }
  return (
    <>
      <CalendarLine />
      {body}
    </>
  );
}
