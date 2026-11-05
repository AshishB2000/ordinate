// A source table's Overview: what an editor wrote (owner, refresh, required filters) and what the last
// read from the warehouse said (keys, partition, cluster, sort, distribution, size), then the datasets
// built from it. A fact the warehouse did not give is left out; what nobody wrote says so. Every figure
// is the warehouse's, formatted only.

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ago, formatNumber } from '../../data/format';
import type { SourceConn, SourceDoc } from './api';
import m from '../Model.module.css';
import x from './Sources.module.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={m.row}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const Cols = ({ names }: { names: string[] }) => <span className={x.mono}>{names.join(', ')}</span>;
const Written = ({ text }: { text: string }) => (text ? <>{text}</> : <span className={m.muted}>Not written yet</span>);

/** `doc` absent: a used table with no notes yet, of which the list knows only how many datasets use it. */
export function SourceOverview({ projectId, conn, doc, datasets, used }: {
  projectId: string;
  conn: SourceConn;
  doc?: SourceDoc;
  datasets?: { id: string; name: string }[];
  used?: number;
}) {
  const f = doc?.facts;
  const rows = f?.rowEstimate !== undefined ? `~${formatNumber(f.rowEstimate)} (the warehouse's estimate)` : '';
  const size = [rows, f?.sizeLabel ?? ''].filter(Boolean).join(' · ');
  return (
    <dl className={`${m.rows} ${x.facts}`}>
      <Row label="Connection">{`${conn.name} (${conn.label})`}</Row>
      <Row label="Owner">
        <Written text={doc?.owner ?? ''} />
      </Row>
      <Row label="Refreshes">
        <Written text={doc?.refresh ?? ''} />
      </Row>
      <Row label="Required">
        <Written text={doc?.requiredFilters ?? ''} />
      </Row>
      {!!f?.primaryKey?.columns.length && (
        <Row label="Primary key">
          <Cols names={f.primaryKey.columns} />
          {!f.primaryKey.enforced && ' (declared, not enforced)'}
        </Row>
      )}
      {!!f?.partition?.columns.length && (
        <Row label="Partitioned by">
          <Cols names={f.partition.columns} />
          {f.partition.method && ` (${f.partition.method})`}
          {f.partition.required && ' · queries must filter on it'}
        </Row>
      )}
      {!!f?.clusterBy?.length && (
        <Row label="Clustered by">
          <Cols names={f.clusterBy} />
        </Row>
      )}
      {!!f?.sortKey?.length && (
        <Row label="Sort key">
          <Cols names={f.sortKey} />
        </Row>
      )}
      {f?.distribution && (
        <Row label="Distribution">
          {f.distribution.style}
          {!!f.distribution.columns.length && (
            <>
              {' ('}
              <Cols names={f.distribution.columns} />
              {')'}
            </>
          )}
        </Row>
      )}
      {size && <Row label={rows ? 'Rows' : 'Size'}>{size}</Row>}
      {f?.lastModified && ago(f.lastModified) && <Row label="Last changed">{ago(f.lastModified)}</Row>}
      {datasets && datasets.length > 0 && (
        <Row label="Built from it">
          <span className={x.links}>
            {datasets.map((d) => (
              <Link key={d.id} className={m.link} to={`/model/${projectId}?tab=datasets&dataset=${d.id}`}>
                {d.name}
              </Link>
            ))}
          </span>
        </Row>
      )}
      {!doc && !!used && <Row label="Built from it">{used === 1 ? '1 dataset' : `${formatNumber(used)} datasets`}</Row>}
    </dl>
  );
}
