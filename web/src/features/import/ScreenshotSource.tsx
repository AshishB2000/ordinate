// "Upload or paste a screenshot" — the server form of the desktop's capture
// (legacy captureDataset.ts + captureStatus.ts). The image is uploaded, the
// org's model reads it ON THE SERVER (captureDataset:draft), and its table
// opens in the composer with editable cells. While the model reads, the step
// list the capture page showed; when it cannot, the typed error card; and
// when no model can run, the not-ready state instead of a drop zone.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { upload } from '../../api/client';
import { Button } from '../../ui/Button';
import { SkeletonBlock } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { useAiStatus } from '../assistant/api';
import { AiNotReady } from '../assistant/AiNotReady';
import { draftCapture } from './api';
import type { ComposerStart } from './Composer';
import { DropZone } from './DropZone';
import { readyImage } from './screenshotImage';
import s from './Import.module.css';

const STEPS = ['Reading your screenshot…', 'Analyzing content…', 'Processing data…', 'Writing the table…'];

/** A model error, by type: an icon, a title, and whether it reads as a warning (legacy CVE_CONFIG). */
const ERRORS: Record<string, { title: string; icon: IconName; warn?: boolean }> = {
  network: { title: 'No connection to the model', icon: 'cloud' },
  auth: { title: 'The API key was rejected', icon: 'lock', warn: true },
  rate_limit: { title: 'Rate limit reached', icon: 'history', warn: true },
  provider: { title: 'The model provider had an error', icon: 'alert' },
  bad_reply: { title: 'Unreadable response', icon: 'info' },
  truncated: { title: 'The response was cut off', icon: 'alert', warn: true },
  not_ready: { title: 'The model is not available', icon: 'sparkles', warn: true },
  bad_image: { title: 'That image could not be read', icon: 'camera' },
  no_table: { title: 'No table in that screenshot', icon: 'table' },
  unknown: { title: 'Something went wrong', icon: 'alert' },
};

type Failure = { errorType: string; message: string; detail?: string };

function Steps() {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setAt((n) => Math.min(STEPS.length - 1, n + 1)), 2500);
    return () => window.clearInterval(t);
  }, []);
  return (
    <ol className={s.steps} role="status" aria-busy="true" aria-label="The model is reading the screenshot">
      {STEPS.map((label, i) => (
        <li key={label} className={s.step} data-status={i < at ? 'done' : i === at ? 'active' : 'pending'}>
          <span className={s.stepIcon} aria-hidden="true">
            {i < at && <Icon name="check" size={12} />}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function FailureCard({ f, onRetry }: { f: Failure; onRetry: () => void }) {
  const cfg = ERRORS[f.errorType] ?? ERRORS.unknown;
  return (
    <div className={cfg.warn ? `${s.failure} ${s.failureWarn}` : s.failure} role="alert">
      <span className={s.failureIcon}>
        <Icon name={cfg.icon} size={24} />
      </span>
      <h3 className={s.failureTitle}>{cfg.title}</h3>
      <p className={s.failureMsg}>{f.message || 'Something went wrong. Try again.'}</p>
      {f.detail && <code className={s.failureDetail}>{f.detail}</code>}
      <div className={s.failureActions}>
        <Button variant="primary" icon="refresh" onClick={onRetry}>
          Try another screenshot
        </Button>
      </div>
    </div>
  );
}

export function ScreenshotSource({ projectId, onComposer }: { projectId: string; onComposer: (start: ComposerStart) => void }) {
  const status = useAiStatus();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const take = async (file: Blob) => {
    setFailure(null);
    setBusy(true);
    try {
      const img = await readyImage(file);
      const up = await upload(img.png, 'screenshot.png');
      const r = await draftCapture({ projectId, fileToken: up.fileToken, thumb: img.thumb });
      void client.invalidateQueries({ queryKey: ['captureDataset:list', projectId] });
      if (!r.ok) return setFailure(r);
      onComposer({
        base: { label: r.title, rows: r.rows.length, kind: 'capture', ref: { inline: { name: r.title, columns: r.columns, rows: r.rows } }, columns: r.columns.map((c) => c.name) },
        name: r.title,
        sourceKind: 'capture',
        origin: { kind: 'capture', captureId: r.captureId },
        capture: true,
        unsure: r.unsure,
        warnings: r.warnings,
      });
    } catch (err) {
      setFailure({ errorType: 'unknown', message: err instanceof Error ? err.message : 'The screenshot could not be read.' });
    } finally {
      setBusy(false);
    }
  };

  // A screenshot on the clipboard: Ctrl/Cmd+V anywhere on the page while this source is open.
  const takeRef = useRef(take);
  takeRef.current = take;
  const ready = status.data?.ready === true && !busy;
  useEffect(() => {
    if (!ready) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      void takeRef.current(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [ready]);

  if (status.isPending) return <SkeletonBlock label="Checking the model" />;
  if (status.isError) return <ErrorState title="The model's status could not be read" message={status.error.message} onRetry={() => void status.refetch()} heading={3} />;
  if (!status.data.ready) {
    return (
      <EmptyState icon="sparkles" heading={3} title="Reading a screenshot needs AI" actions={<AiNotReady status={status.data} />} />
    );
  }
  if (busy) return <Steps />;
  if (failure) return <FailureCard f={failure} onRetry={() => setFailure(null)} />;
  return (
    <DropZone
        icon="camera"
        title="Drop a screenshot, or paste one"
        hint="A chart, a table, a dashboard — the model reads the figures out of it on the server, and you check every cell before it is saved. Ctrl+V / ⌘V pastes from the clipboard."
        accept="image/*"
        choose="Choose an image"
        onFile={(f) => void take(f)}
      />
  );
}
