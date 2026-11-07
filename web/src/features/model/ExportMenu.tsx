// Export ▾ on the Data model (semantic layer part 7, a1): the project's definitions as model files, a zip the
// browser downloads (`model:export`). Editors only: the page shows it beside New term.
// Ossie (g1) downloads one Ossie document, then opens the report of what did not map.

import { useState } from 'react';
import { startDownload } from '../../api/files';
import { Button } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { toast } from '../../ui/Toast';
import { exportedText, exportModel, exportOssie, type OssieExportReply } from './api';
import { OssieReportDialog } from './OssieReportDialog';

export function ExportMenu({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [ossie, setOssie] = useState<Extract<OssieExportReply, { ok: true }> | null>(null);
  const failed = (err: unknown) => toast(`The export failed: ${err instanceof Error && err.message !== 'forbidden' ? err.message : 'you do not have permission'}.`, { kind: 'error' });
  const ossieFile = async () => {
    setBusy(true);
    try {
      const r = await exportOssie(projectId);
      if (!r.ok) return void toast(r.error, { kind: 'error' });
      startDownload(r.downloadToken);
      setOssie(r);
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };
  const modelFiles = async () => {
    setBusy(true);
    try {
      const r = await exportModel(projectId);
      if (!r.ok) return void toast(r.error, { kind: 'error' });
      startDownload(r.downloadToken);
      toast(exportedText(r.notCarried), { kind: 'success' });
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Menu
        label="Export"
        align="end"
        trigger={
          <Button icon="download" iconEnd="chevron-down" loading={busy}>
            Export
          </Button>
        }
        items={[
          { label: 'Model files', icon: 'file-text', onSelect: () => void modelFiles() },
          { label: 'Ossie', icon: 'file-text', onSelect: () => void ossieFile() },
        ]}
      />
      {ossie && <OssieReportDialog version={ossie.version} report={ossie.report} onClose={() => setOssie(null)} />}
    </>
  );
}
