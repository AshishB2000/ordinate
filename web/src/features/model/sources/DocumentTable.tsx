// "Document in Data model" for one table (Connections' results; part 2's dataset Guide): start the
// table's notes (idempotent by its exact name, so a second click opens the same doc), then open them by
// connection and doc id, never by name.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../ui/Button';
import { toast } from '../../../ui/Toast';
import { LIST, startNotes } from './api';

export function useDocumentTable(projectId: string) {
  const navigate = useNavigate();
  const client = useQueryClient();
  return async (connId: string, table: string): Promise<void> => {
    const docId = await startNotes(projectId, connId, table);
    void client.invalidateQueries({ queryKey: [LIST, projectId] });
    void navigate(`/model/${projectId}?tab=sources&conn=${connId}&doc=${docId}`);
  };
}

export function DocumentTableButton({ projectId, connId, table }: { projectId: string; connId: string; table: string }) {
  const documentTable = useDocumentTable(projectId);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await documentTable(connId, table);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : 'The notes could not be started.', { kind: 'error' });
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" icon="file-text" iconEnd="external-link" loading={busy} onClick={() => void go()} title="Write this table's owner, refresh and guide, and read what the warehouse knows">
      Document in Data model
    </Button>
  );
}
