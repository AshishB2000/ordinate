// Organization → Backups — settingsBackups.ts on a server: an org admin
// DOWNLOADS every project as one file and RESTORES one by uploading it (T0.4
// tokens both ways). A restore brings each project back as a NEW project — as
// on the desktop, nothing here now is overwritten — and adds every one of them
// to the org at once, so it takes the typed word; the server checks the word
// too, and audits both calls. The desktop's schedule, folder and retention are
// gone: on a server the operator backs up Postgres and the volume or bucket.

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc, upload } from '../../api/client';
import { startDownload } from '../../api/files';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { Group, Row } from './Rows';
import s from './Settings.module.css';

type Restored = { ok: true; restored: { id: string; name: string }[]; failed: { name: string; error: string }[] } | { ok: false; error?: string; canceled?: boolean };
const WORD = 'restore';

function RestoreDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const client = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Extract<Restored, { ok: true }> | null>(null);
  const reset = (o: boolean) => {
    if (busy) return;
    if (!o) {
      setFile(null);
      setTyped('');
      setError('');
      setDone(null);
    }
    onOpenChange(o);
  };
  const run = async () => {
    if (!file || typed.trim().toLowerCase() !== WORD) return;
    setBusy(true);
    setError('');
    try {
      const up = await upload(file, file.name);
      const r = (await rpc('backups:restore', { fileToken: up.fileToken, confirm: WORD })) as Restored;
      if (!r.ok) setError(r.error ?? 'The backup could not be restored.');
      else {
        setDone(r);
        for (const key of ['projects:overview', 'projects:list', 'projects:roles', 'admin:projects']) void client.invalidateQueries({ queryKey: [key] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The backup could not be restored.');
    } finally {
      setBusy(false);
    }
  };
  const ready = !!file && typed.trim().toLowerCase() === WORD;
  return (
    <Dialog
      open={open}
      onOpenChange={reset}
      title="Restore from a backup"
      description="Each project in the file comes back as a new project. Nothing in the organization now is changed."
      footer={
        done ? (
          <DialogClose asChild>
            <Button variant="primary">Close</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button disabled={busy}>Cancel</Button>
            </DialogClose>
            <Button variant="danger" icon="rotate-ccw" disabled={!ready} loading={busy} onClick={() => void run()}>
              Restore as new projects
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div role="status">
          <p className={s.lead}>
            <Icon name="circle-check" /> {done.restored.length} project{done.restored.length === 1 ? '' : 's'} restored
            {done.failed.length ? `, ${done.failed.length} could not be` : ''}. Open them from the project switcher.
          </p>
          <ul className={s.note} aria-label="Restored projects">
            {done.restored.map((p) => (
              <li key={p.id}>{p.name}</li>
            ))}
            {done.failed.map((p) => (
              <li key={p.name} className={s.err}>
                {p.name}: {p.error}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={s.side}>
          <div className={s.filePick}>
            <input ref={picker} type="file" accept=".zip,application/zip" hidden aria-label="Backup file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button icon="upload" disabled={busy} onClick={() => picker.current?.click()}>
              Choose a backup file…
            </Button>
            <span className={file ? s.fileName : s.note} data-testid="backup-file">
              {file ? file.name : 'An Ordinate backup (.zip) downloaded from this page.'}
            </span>
          </div>
          <Input
            label={`Type “${WORD}” to confirm`}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run()}
            hint="Restoring adds every project in the file to the organization. It is recorded in the audit log."
          />
          {error && (
            <p className={s.err} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function BackupsTab() {
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const r = (await rpc('backups:download')) as { ok: boolean; count?: number; downloadToken?: string; error?: string };
      if (!r.ok || !r.downloadToken) throw new Error(r.error ?? 'The backup failed.');
      startDownload(r.downloadToken);
      toast(`${r.count} project${r.count === 1 ? '' : 's'} backed up — the download has started.`, { kind: 'success' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The backup failed.', { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.stackPage}>
      <Group title="Back up" desc="Every project in the organization — its records, data, version history and share policy — as one file you keep.">
        <Row title="Download a backup" desc="Unmasked: the backup carries every column as it is, so keep the file as safe as the data. Recorded in the audit log.">
          <Button variant="primary" icon="hard-drive" loading={busy} onClick={() => void download()}>
            Download backup
          </Button>
        </Row>
      </Group>
      <Group title="Restore" desc="Bring a backup back. Each project returns as a new one, named “… (restored <date>)” — the projects here now are never overwritten.">
        <Row title="Restore from a backup" desc="Upload a file downloaded from this page. You will be asked to type a word to confirm.">
          <Button icon="rotate-ccw" onClick={() => setRestoring(true)}>
            Restore from a backup…
          </Button>
        </Row>
      </Group>
      <p className={s.note}>
        Scheduled backups and a backup folder were part of the desktop app. On a server, the operator backs up its Postgres database and its data volume or bucket; this page is for
        taking a copy of the organization's work, or moving it.
      </p>
      <RestoreDialog open={restoring} onOpenChange={setRestoring} />
    </div>
  );
}
