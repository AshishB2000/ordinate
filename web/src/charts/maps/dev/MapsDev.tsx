// /dev/maps — every map kind drawn from the API over the sample project, for
// review in both themes and for the e2e (web/e2e/maps.e2e.ts). Not in the nav.
//
// The bundled sample ("Retail orders") has states but no coordinates, so it
// draws the region, bubble and offline-basemap maps; the point, hexbin and
// flow maps read a "Shipments" dataset with latitude/longitude columns (the
// e2e seed adds one — scripts/geoFixture.ts). Without it those three cards say
// what they need. `?project=<id>` picks a project; else the first one.
//
// ponytail: shipped in the production bundle (a lazy chunk, never in the
// initial one) because the e2e runs against the production build; drop it, or
// gate it on a build mode, when T8.1 cuts over.

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useDatasets, type DatasetSummary } from '../../../api/datasets';
import { useProjects } from '../../../api/projects';
import { EmptyState, ErrorState, Page } from '../../../app/blocks';
import { Badge } from '../../../ui/Badge';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { useMapData, type MapDataInput } from '../api';
import { MapThumb } from '../MapThumb';
import { MapView } from '../MapView';
import { RadiusEditor } from '../RadiusEditor';
import { radiusSteps, type RadiusState } from '../radius';
import s from './MapsDev.module.css';

const SAMPLE = 'Retail orders';
const SHIPMENTS = 'Shipments';

type Encoding = MapDataInput['encoding'];
interface Card {
  id: string;
  title: string;
  kind: string;
  chartType: string;
  dataset: typeof SAMPLE | typeof SHIPMENTS;
  encoding: Encoding;
  blurb: string;
}

const sum = (column: string) => [{ column, aggregation: 'sum' as const }];
const ship = { lat: 'lat', lon: 'lon' };

const CARDS: readonly Card[] = [
  { id: 'region', title: 'Profit by state', kind: 'Region', chartType: 'map_choropleth', dataset: SAMPLE,
    encoding: { category: 'state', values: sum('profit'), geo: { level: 'us_state' } }, blurb: 'Choropleth over the bundled US states, OSM tiles beneath.' },
  { id: 'bubble', title: 'Revenue by state', kind: 'Bubble', chartType: 'map_bubble', dataset: SAMPLE,
    encoding: { category: 'state', values: sum('revenue'), geo: { level: 'us_state' } }, blurb: 'Named regions placed at their boundary centroids.' },
  { id: 'offline', title: 'Units by state, offline basemap', kind: 'Region · no tiles', chartType: 'map_choropleth', dataset: SAMPLE,
    encoding: { category: 'state', values: sum('units'), geo: { level: 'us_state', basemap: 'none' } }, blurb: 'Land and water from the bundled world shapes — no network at all.' },
  { id: 'points', title: 'Deliveries by carrier', kind: 'Points', chartType: 'map_bubble', dataset: SHIPMENTS,
    encoding: { category: 'city', values: sum('weight_kg'), geo: { level: 'point', ...ship, color: 'carrier' } }, blurb: 'One mark per row, clustered on a grid above 2,000 points.' },
  { id: 'hexbin', title: 'Delivered weight density', kind: 'Hexbin', chartType: 'map_hexbin', dataset: SHIPMENTS,
    encoding: { category: 'city', values: sum('weight_kg'), geo: { level: 'hexbin', ...ship } }, blurb: 'Hexagon levels computed on the server; the zoom picks one.' },
  { id: 'flow', title: 'Warehouse → city routes', kind: 'Flow', chartType: 'map_flow', dataset: SHIPMENTS,
    encoding: { category: 'city', values: sum('weight_kg'), geo: { level: 'flow', lat: 'wh_lat', lon: 'wh_lon', lat2: 'city_lat', lon2: 'city_lon', from: 'warehouse', to: 'city' } },
    blurb: 'The heaviest routes, arcs laid out on the server.' },
];

function MapCard({ card, projectId, ds, filters }: { card: Card; projectId: string; ds: DatasetSummary | undefined; filters?: MapDataInput['filters'] }) {
  const q = useMapData(ds ? { projectId, datasetId: ds.id, encoding: card.encoding, ...(filters?.length ? { filters } : {}) } : undefined);
  let body;
  if (!ds) {
    body = (
      <EmptyState icon="map-pin" title={`Needs a “${card.dataset}” dataset`} compact heading={3}>
        {card.dataset === SHIPMENTS ? 'A dataset with latitude and longitude columns — the e2e seed adds one.' : 'The bundled sample dataset.'}
      </EmptyState>
    );
  } else if (q.isPending) body = <SkeletonBlock label={`Loading ${card.title}`} />;
  else if (q.isError) body = <ErrorState title="The map data could not be loaded" message={q.error.message} compact heading={3} onRetry={() => void q.refetch()} />;
  else if (!q.data.ok) body = <ErrorState title="This map cannot be drawn" message={q.data.error} compact heading={3} />;
  else body = <MapView data={q.data.data} chartType={card.chartType} label={card.title} projectId={projectId} />;
  return (
    <section className={s.card} aria-labelledby={`map-${card.id}`} data-map-card={card.id}>
      <header className={s.cardHead}>
        <h2 id={`map-${card.id}`} className={s.cardTitle}>
          {card.title}
        </h2>
        <Badge>{card.kind}</Badge>
      </header>
      <p className={s.blurb}>{card.blurb}</p>
      <div className={s.mapBox}>{body}</div>
      {ds && q.data?.ok && (
        <div className={s.thumbRow}>
          <span className={s.thumbLabel}>Gallery thumbnail</span>
          <div className={s.thumbBox}>
            <MapThumb data={q.data.data} chartType={card.chartType} label={`${card.title} thumbnail`} projectId={projectId} />
          </div>
        </div>
      )}
    </section>
  );
}

function Maps({ projectId }: { projectId: string }) {
  const q = useDatasets(projectId);
  const [radius, setRadius] = useState<RadiusState | null>(null);
  if (q.isPending) return <SkeletonBlock label="Loading datasets" />;
  if (q.isError) return <ErrorState title="Datasets could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const byName = (n: string) => q.data.find((d) => d.name === n);
  const filters = radiusSteps({ column: 'lat', lngColumn: 'lon' }, radius);
  return (
    <>
      <section className={s.radius} aria-labelledby="map-radius">
        <h2 id="map-radius" className={s.cardTitle}>
          Radius control
        </h2>
        <p className={s.blurb}>Narrows the points map to deliveries within a distance of a place from the offline table.</p>
        <RadiusEditor onChange={setRadius} />
      </section>
      <div className={s.grid}>
        {CARDS.map((c) => (
          <MapCard key={c.id} card={c} projectId={projectId} ds={byName(c.dataset)} filters={c.id === 'points' ? filters : undefined} />
        ))}
      </div>
    </>
  );
}

export default function MapsDev() {
  const [params] = useSearchParams();
  const projects = useProjects();
  const projectId = params.get('project') || projects.data?.[0]?.id;
  let body;
  if (projects.isPending) body = <SkeletonBlock label="Loading projects" />;
  else if (projects.isError) body = <ErrorState title="Projects could not be loaded" message={projects.error.message} onRetry={() => void projects.refetch()} />;
  else if (!projectId) body = <EmptyState icon="map" title="No project to map">Seed the sample project, or open /dev/maps?project=&lt;id&gt;.</EmptyState>;
  else body = <Maps projectId={projectId} />;
  return (
    <Page title="Maps" sub="Every map kind, drawn from the server over the sample project. Development only — not in the nav.">
      {body}
    </Page>
  );
}
