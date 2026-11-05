// Export ▾ on the Data model (semantic layer part 7, a1): the project's definitions as model files, a zip the
// browser downloads (`model:export`). Editors only: the page shows it beside New term. A later step adds Ossie.

import { useState } from 'react';
import { startDownload } from '../../api/files';
import { Button } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { toast } from '../../ui/Toast';
import { exportedText, exportModel } from './api';

export function ExportMenu({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const modelFiles = async () => {
    setBusy(true);
    try {
      const r = await exportModel(projectId);
      if (!r.ok) return void toast(r.error, { kind: 'error' });
      startDownload(r.downloadToken);
      toast(exportedText(r.notCarried), { kind: 'success' });
    } catch (err) {
      toast(`The export failed: ${err instanceof Error && err.message !== 'forbidden' ? err.message : 'you do not have permission'}.`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Menu
      label="Export"
      align="end"
      trigger={
        <Button icon="download" iconEnd="chevron-down" loading={busy}>
          Export
        </Button>
      }
      items={[{ label: 'Model files', icon: 'file-text', onSelect: () => void modelFiles() }]}
    />
  );
}
