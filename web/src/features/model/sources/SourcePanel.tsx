// The picked source table's panel: its name, the connection it is on and when it was last read. A table
// datasets are built from that has no doc yet offers Start its notes, which creates the empty doc and
// then puts its id (never its name) in the address.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { ConnLogo } from '../../connections/ConnLogo';
import { useLogos } from '../../connections/api';
import { LIST, startNotes, type SourceConn, type SourceRow } from './api';
import m from '../Model.module.css';
import x from './Sources.module.css';

export function SourcePanel({ projectId, conn, row, onStarted }: { projectId: string; conn: SourceConn; row: SourceRow; onStarted: (docId: string) => void }) {
  const client = useQueryClient();
  const logos = useLogos().data ?? {};
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState('');
  const start = async () => {
    setStarting(true);
    setProblem('');
    try {
      const docId = await startNotes(projectId, conn.connId, row.table);
      await client.invalidateQueries({ queryKey: [LIST, projectId] });
      onStarted(docId);
    } catch (err) {
      setProblem(err instanceof Error && err.message ? err.message : 'The notes could not be started.');
      setStarting(false);
    }
  };
  return (
    <section className={m.panel} aria-label={`About ${row.table}`}>
      <div className={m.panelHead}>
        <div className={x.headMain}>
          <div className={m.panelTitle}>
            <h2>
              <span className={x.mono}>{row.table}</span>
            </h2>
            {!row.docId && <Badge tone="warn">no doc</Badge>}
          </div>
          <div className={x.ident}>
            <ConnLogo small logo={logos[conn.connectorId]} label={conn.label} />
            <div>
              <p className={x.connName}>
                {conn.name} <span className={m.muted}>{`· ${conn.label}`}</span>
              </p>
              <p className={x.readLine}>No notes yet</p>
            </div>
          </div>
        </div>
        {!row.docId && (
          <div className={m.panelActions}>
            <Button variant="primary" icon="pencil" loading={starting} onClick={() => void start()}>
              Start its notes
            </Button>
          </div>
        )}
      </div>
      {problem && (
        <div className={x.alert} role="alert">
          <Icon name="alert" size={16} />
          <span className={x.alertText}>{problem}</span>
        </div>
      )}
    </section>
  );
}
