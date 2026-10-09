// The tabs of a Live dataset's page (docs/live-data/00-plan.md L2.6). A Live
// dataset keeps its schema here and its rows in the warehouse, so:
//
//   Data       what works (charts, KPI tiles, answers), what needs a copy, and
//              the two ways to get one (./LiveMode LiveNotice)
//   Schema     the last sync: columns, a sample's profile, columns gone — and
//              "Sync schema" (./SchemaPanel)
//   Columns    the column notes, as on any dataset
//   Quality · Insights · Snapshots   off in v1, each saying why, with "Make a copy"
//
// Nothing here calls a row-reading channel: the off tabs are words and a button.

import type { DatasetColumns } from '../../api/datasets';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { LiveOff } from '../live/LiveOff';
import { ColumnsTab } from './ColumnsTab';
import { LiveNotice } from './LiveMode';
import { SchemaPanel } from './SchemaPanel';

export const LIVE_TABS = ['data', 'schema', 'columns', 'quality', 'insights', 'snapshots'] as const;
export type LiveTabId = (typeof LIVE_TABS)[number];

export function LiveTabs({ projectId, datasetId, header, tab, onTab, maxCacheAgeSec }: {
  projectId: string;
  datasetId: string;
  header: DatasetColumns;
  tab: string;
  onTab: (v: string) => void;
  maxCacheAgeSec?: number;
}) {
  const value: LiveTabId = (LIVE_TABS as readonly string[]).includes(tab) ? (tab as LiveTabId) : 'data';
  return (
    <Tabs value={value} onValueChange={onTab}>
      <TabList label="Dataset views">
        <Tab value="data" icon="table">
          Data
        </Tab>
        <Tab value="schema" icon="database">
          Schema
        </Tab>
        <Tab value="columns" icon="columns">
          Columns
        </Tab>
        <Tab value="quality" icon="circle-check">
          Quality
        </Tab>
        <Tab value="insights" icon="zap">
          Insights
        </Tab>
        <Tab value="snapshots" icon="history">
          Snapshots
        </Tab>
      </TabList>
      <TabPanel value="data">
        <LiveNotice projectId={projectId} datasetId={datasetId} maxCacheAgeSec={maxCacheAgeSec} />
      </TabPanel>
      <TabPanel value="schema">
        <SchemaPanel projectId={projectId} datasetId={datasetId} />
      </TabPanel>
      <TabPanel value="columns">
        <ColumnsTab projectId={projectId} datasetId={datasetId} header={header} live />
      </TabPanel>
      <TabPanel value="quality">
        <LiveOff projectId={projectId} datasetId={datasetId} feature="quality" heading={3} />
      </TabPanel>
      <TabPanel value="insights">
        <LiveOff projectId={projectId} datasetId={datasetId} feature="insights" heading={3} />
      </TabPanel>
      <TabPanel value="snapshots">
        <LiveOff projectId={projectId} datasetId={datasetId} feature="snapshots" heading={3} />
      </TabPanel>
    </Tabs>
  );
}
