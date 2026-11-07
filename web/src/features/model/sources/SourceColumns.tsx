// A source table's Columns: each column's warehouse type, comment and key mark, from the last read.
// Never read: the way to read it (a click), or, for a source with no catalog, that its notes are typed.

import type { ReactNode } from 'react';
import { Badge } from '../../../ui/Badge';
import { EmptyState } from '../../../ui/States';
import type { SourceConn, SourceDoc } from './api';
import x from './Sources.module.css';

/** The server's factsNotReadable() wording (src/app/sourceTableMessages.ts). */
export const BY_HAND = 'This source has no catalog Ordinate can read. Write its notes by hand.';

export function SourceColumns({ conn, doc, readButton }: { conn: SourceConn; doc: SourceDoc; readButton: ReactNode }) {
  const cols = doc.facts?.columns;
  if (!cols) {
    return (
      <EmptyState icon="columns" heading={3} title="Not read from the warehouse yet" actions={conn.readsFacts && readButton}>
        {conn.readsFacts ? `Read its columns, comments, keys and partitions from ${conn.name}. Nothing is asked of the warehouse until you click.` : BY_HAND}
      </EmptyState>
    );
  }
  return (
    <div className={x.tableWrap}>
      <table className={x.cols} aria-label={`Columns of ${doc.table}`}>
        <thead>
          <tr>
            <th scope="col">Column</th>
            <th scope="col">Warehouse type</th>
            <th scope="col">Comment</th>
            <th scope="col">Key</th>
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.name}>
              <td className={x.mono}>{c.name}</td>
              <td className={x.type}>{c.type}</td>
              <td>{c.comment || <span className={x.none}>No comment</span>}</td>
              <td>{c.key && <Badge tone="ok">key</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
