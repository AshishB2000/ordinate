// /data/:projectId — the Data section (dataSection.ts, dsList.ts, captureList's
// tab strip): the project's datasets, its captures and the catalog of every
// record, one tab each (the tab is in the URL). The header's actions belong to
// Datasets, as on the desktop. Relationships moved to the Data model: an old
// `?tab=relationships` link lands there.

import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { useDatasets } from '../../api/datasets';
import { Page } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { CapturesTab } from './CapturesTab';
import { CatalogTab } from './CatalogTab';
import { DatasetList } from './DatasetList';
import { DataSearch } from './DataSearch';
import { useCanEdit } from '../projects/api';
import { useAdoptProject } from '../projects/current';

const TABS = ['datasets', 'captures', 'catalog', 'relationships'] as const;
type TabId = (typeof TABS)[number];

const SUB: Record<Exclude<TabId, 'relationships'>, string> = {
  datasets: 'Import a file, paste data, or connect a database, warehouse or app. Each saves a structured dataset in this project.',
  captures: 'Screenshots turned into tables. Each one becomes a dataset once you review it.',
  catalog: 'Every dataset, visual, dashboard, metric and report, with its description, tags, owner and use.',
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

  if (tab === 'relationships') return <Navigate to={`/model/${projectId}?tab=relationships`} replace />;
  return (
    <Page
      title="Data"
      sub={SUB[tab]}
      actions={
        <>
          {/* The project's metrics (T2.8): the Data model's Metrics tab. */}
          <Link className={buttonClass('ghost')} to={`/model/${projectId}?tab=metrics`}>
            <Icon name="target" />
            <span>Metrics</span>
          </Link>
          {tab === 'datasets' && !empty && canEdit && (
            <>
              <Link className={buttonClass('ghost')} to={`/data/import?project=${projectId}&source=paste`}>
                Paste data
              </Link>
              {/* The 40 databases, warehouses and apps (T2.5) are a connection, not an upload. */}
              <Link className={buttonClass('secondary')} to={`/connections/${projectId}`}>
                <Icon name="plug" />
                <span>Connect a database</span>
              </Link>
              <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
                Import file
              </Link>
            </>
          )}
        </>
      }
    >
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
      </Tabs>
    </Page>
  );
}
