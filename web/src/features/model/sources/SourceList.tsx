// The Source tables tab's list: the tables, grouped by connection. A documented table is a link (its
// connection and doc ids, never its name); a table datasets are built from that has no doc yet is a
// button, picked in the page, so no address ever names it.

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from '../../../ui/icons/Icon';
import { formatNumber } from '../../data/format';
import type { SourceConn, SourceRow } from './api';
import m from '../Model.module.css';
import x from './Sources.module.css';

export interface Picked {
  conn: SourceConn;
  row: SourceRow;
}

const builtFrom = (n: number): string => (n === 0 ? 'no datasets' : n === 1 ? '1 dataset' : `${formatNumber(n)} datasets`);

function Item({ row, on, href, onLoose, onLink }: { row: SourceRow; on: boolean; href: string; onLoose: () => void; onLink: () => void }) {
  const cls = on ? `${m.item} ${m.itemOn}` : m.item;
  const warn = row.datasetIds.length > 0 && !row.docId;
  const inner = (
    <>
      <span className={m.itemName}>
        <Icon name="table" size={16} />
        <span className={x.mono}>{row.table}</span>
      </span>
      <span className={warn ? `${x.meta} ${x.metaWarn}` : x.meta}>
        {row.docId ? builtFrom(row.datasetIds.length) : 'no doc'}
        {warn && <Icon name="alert" size={12} label="Datasets are built from it, and it has no doc" />}
      </span>
    </>
  );
  return row.docId ? (
    <Link className={cls} to={href} replace aria-current={on ? 'true' : undefined} onClick={onLink}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={`${cls} ${x.itemBtn}`} aria-current={on ? 'true' : undefined} onClick={onLoose}>
      {inner}
    </button>
  );
}

export function SourceList({ conns, picked, hrefOf, onLoose, onLink, addFor }: {
  conns: SourceConn[];
  picked: Picked;
  hrefOf: (connId: string, docId: string) => string;
  onLoose: (connId: string, table: string) => void;
  onLink: () => void;
  /** The group's + Add. */
  addFor: (conn: SourceConn) => ReactNode;
}) {
  return (
    <nav className={m.list} aria-label="Source tables">
      {conns.map((c) => {
        const capId = `source-group-${c.connId}`;
        return (
          <div key={c.connId}>
            <div className={x.groupHead}>
              <span className={x.groupName}>
                <span id={capId} className={`${m.groupCap} ${x.cap}`}>
                  {c.name}
                </span>
                <span className={x.connKind}>{c.label}</span>
              </span>
              {addFor(c)}
            </div>
            <ul className={m.group} aria-labelledby={capId}>
              {c.rows.map((r) => (
                <li key={r.docId ?? `used:${r.table}`}>
                  <Item
                    row={r}
                    on={picked.conn.connId === c.connId && picked.row === r}
                    href={r.docId ? hrefOf(c.connId, r.docId) : ''}
                    onLoose={() => onLoose(c.connId, r.table)}
                    onLink={onLink}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
