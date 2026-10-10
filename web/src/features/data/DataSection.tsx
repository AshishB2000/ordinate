// /data/:projectId — the Data section (dataSection.ts, dsList.ts, captureList's
// tab strip): the project's datasets, its captures, the catalog of every
// record and the relationships between datasets, one tab each (the tab is in
// the URL). The header's actions belong to Datasets, as on the desktop.

import { Link, useParams, useSearchParams } from 'react-router';
import { useDatasets } from '../../api/datasets';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { CapturesTab } from './CapturesTab';
import { CatalogTab } from './CatalogTab';
import { DatasetList } from './DatasetList';
import { DataSearch } from './DataSearch';
import { useCanEdit } from '../projects/api';
import { useAdoptProject } from '../projects/current';
import { RelationshipsTab } from './RelationshipsTab';
import s from './Data.module.css';

const TABS = ['datasets', 'captures', 'catalog', 'relationships'] as const;
type TabId = (typeof TABS)[number];

const SUB: Record<TabId, string> = {
  datasets: 'Import CSV, JSON or Excel — or paste data — to save a structured dataset in this project.',
  captures: 'Screenshots turned into tables. Each one becomes a dataset once you review it.',
  catalog: 'Every dataset, visual, dashboard, metric and report, with its description, tags, owner and use.',
  relationships: 'Relate datasets once; visuals then use columns from both.',
};

export default function DataSection() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  // With no datasets the empty card holds Import / Paste: the header shows them once, not twice (dsList.ts).
  const empty = useDatasets(projectId).data?.length === 0;
  const canEdit = useCanEdit(projectId);
  const asked = params.get('tab');
  const tab: TabId = (TABS as readonly string[]).includes(asked ?? '') ? (asked as TabId) : 'datasets';
  // The URL names the project: the shell's switcher shows it (T2.2).
  useAdoptProject(projectId);

  const setTab = (v: string) =>
    setParams((p) => {
      const q = new URLSearchParams(p);
      if (v === 'datasets') q.delete('tab');
      else q.set('tab', v);
      return q;
    }, { replace: true });

  return (
    <div className={s.page}>
      <header className={s.head}>
        <div className={s.headText}>
          <h1 className={s.title}>Data</h1>
          <p className={s.sub}>{SUB[tab]}</p>
        </div>
        <div className={s.headTools}>
          {/* The project's metrics (T2.8): the desktop's Metrics tab under Data, on its own route. */}
          <Link className={buttonClass('ghost')} to={`/data/metrics?project=${projectId}`}>
            <Icon name="target" />
            <span>Metrics</span>
          </Link>
          {tab === 'datasets' && !empty && canEdit && (
            <>
              <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
                Import file
              </Link>
              <Link className={buttonClass('ghost')} to={`/data/import?project=${projectId}&source=paste`}>
                Paste data
              </Link>
            </>
          )}
        </div>
      </header>
      <DataSearch projectId={projectId} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Data views">
          <Tab value="datasets" icon="database">
            Datasets
          </Tab>
          <Tab value="captures" icon="camera">
            Captures
          </Tab>
          <Tab value="catalog" icon="list">
            Catalog
          </Tab>
          <Tab value="relationships" icon="link">
            Relationships
          </Tab>
        </TabList>
        <TabPanel value="datasets">
          <DatasetList projectId={projectId} />
        </TabPanel>
        <TabPanel value="captures">
          <CapturesTab projectId={projectId} />
        </TabPanel>
        <TabPanel value="catalog">
          <CatalogTab projectId={projectId} />
        </TabPanel>
        <TabPanel value="relationships">
          <RelationshipsTab projectId={projectId} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
