// /analyses/:projectId/rebuild — rebuild another BI tool's dashboard from its
// screenshot, on your own data (docs/rebuild-from-screenshot/00-design.md).
//
//   drop → the model reads the screenshot's STRUCTURE on the server
//   (rebuild:read) → the check: the screenshot with each tile outlined, and
//   per tile its fields mapped to your columns by app code (rebuild:match,
//   re-asked on every correction) → "Create dashboard" through the one door
//   every plan takes (analysis:buildPlan).
//
// The model never supplies a number: the server drops any it reads, and every
// figure on this page — a KPI, a chart preview — is the engine's.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { useDatasets } from '../../../api/datasets';
import { EmptyState, ErrorState, Page, PageSkeleton, type Back } from '../../../app/blocks';
import { Button, buttonClass } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { useAiStatus } from '../../assistant/api';
import { AiNotReady } from '../../assistant/AiNotReady';
import { DropZone } from '../../import/DropZone';
import { readyImage } from '../../import/screenshotImage';
import { useCanEdit } from '../../projects/api';
import { failure, type BuildReply } from '../api';
import { readScreenshot, useMatch, type Override, type Reading } from './api';
import { RebuildCheck } from './RebuildCheck';
import { RebuildShot } from './RebuildShot';
import s from './Rebuild.module.css';

const STEPS = ['Reading the screenshot', 'Finding the tiles', 'Naming the fields', 'Matching them to your columns'];
const HOW = [
  ['camera', 'The model reads the layout', 'Which tiles, where, of what kind, over which fields — never the numbers on them.'],
  ['columns', 'Ordinate matches your columns', 'By name and by type: a sum needs a number column. You can change any match.'],
  ['layout-dashboard', 'Your data fills it', 'Every KPI and chart is computed from your dataset, then it opens as a dashboard you own.'],
] as const;

/** A blob as a data: URL — the one image source the CSP allows besides the app's own. */
function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('The screenshot could not be shown.'));
    r.readAsDataURL(blob);
  });
}

function Reading() {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setAt((n) => Math.min(STEPS.length - 1, n + 1)), 2200);
    return () => window.clearInterval(t);
  }, []);
  return (
    <section className={s.card} aria-label="Reading">
      <h2 className={s.label}>
        <Icon name="sparkles" size={12} />
        Reading your dashboard
      </h2>
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
      <p className={s.muted}>Only the layout is read. The numbers on the screenshot are never used — every figure comes from your data.</p>
    </section>
  );
}

export default function RebuildPage() {
  const { projectId = '' } = useParams();
  const [params] = useSearchParams();
  const status = useAiStatus();
  const canEdit = useCanEdit(projectId);
  const sets = useDatasets(projectId);
  const navigate = useNavigate();
  const client = useQueryClient();

  const list = useMemo(() => sets.data ?? [], [sets.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const preset = params.get('dataset');
  const datasetId = picked ?? (list.find((d) => d.id === preset) ?? list[0])?.id ?? null;
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ message: string; detail?: string } | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [name, setName] = useState<string | null>(params.get('name'));
  const [lit, setLit] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const match = useMatch(projectId, datasetId, reading, overrides);

  const take = async (file: Blob) => {
    setFailed(null);
    setReading(null);
    setOverrides([]);
    setBusy(true);
    try {
      const img = await readyImage(file);
      setShot(await dataUrlOf(img.png)); // the page's own copy (CSP: img-src data:); nothing is stored on the server
      const r = await readScreenshot(projectId, img.png);
      if (r.ok) setReading(r.reading);
      else if ('notReady' in r) void client.invalidateQueries({ queryKey: ['ai:status'] });
      else setFailed({ message: r.message, detail: r.detail });
    } catch (err) {
      setFailed({ message: failure(err, 'The screenshot could not be read.') });
    } finally {
      setBusy(false);
    }
  };
  const takeRef = useRef(take);
  takeRef.current = take;
  const dropping = status.data?.ready === true && canEdit && !busy && !reading;
  useEffect(() => {
    if (!dropping) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      void takeRef.current(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [dropping]);

  const restart = () => {
    setReading(null);
    setOverrides([]);
    setFailed(null);
    setShot(null);
  };
  const change = (next: Override) => setOverrides((list) => [...list.filter((o) => o.id !== next.id), next]);

  const create = async () => {
    const m = match.data;
    if (!m || !m.ok) return;
    setBuilding(true);
    try {
      const chosen = (name ?? '').trim() || m.name;
      const r = (await rpc('analysis:buildPlan', { projectId, plan: { ...m.plan, name: chosen } })) as BuildReply;
      if (!r.ok) throw new Error(r.error);
      void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });
      void navigate(`/analyses/${projectId}/${r.analysis.id}`);
    } catch (err) {
      toast(failure(err, 'The dashboard could not be created.'), { kind: 'error' });
    } finally {
      setBuilding(false);
    }
  };

  const title = 'Rebuild a dashboard from a screenshot';
  const sub = 'Drop a screenshot of a Tableau, Power BI, Looker or Metabase dashboard. The model reads its layout — never its numbers — and Ordinate rebuilds it on your data.';
  const back: Back = { to: `/dashboards?project=${projectId}`, label: 'Dashboards' };

  if (status.isPending || sets.isPending) return <PageSkeleton />;
  if (status.isError) {
    return (
      <Page back={back} title={title}>
        <ErrorState title="The model’s status could not be read" message={status.error.message} onRetry={() => void status.refetch()} />
      </Page>
    );
  }
  if (sets.isError) {
    return (
      <Page back={back} title={title}>
        <ErrorState title="Datasets could not be loaded" message={sets.error.message} onRetry={() => void sets.refetch()} />
      </Page>
    );
  }
  if (!status.data?.ready) {
    return (
      <Page back={back} title={title} sub={sub}>
        <EmptyState icon="sparkles" title="Reading a dashboard screenshot needs AI" actions={<AiNotReady status={status.data ?? undefined} className={s.aiNote} />}>
          Templates, layouts and blank sheets work without a model — start one from Dashboards → New.
        </EmptyState>
      </Page>
    );
  }
  if (!canEdit) {
    return (
      <Page back={back} title={title} sub={sub}>
        <EmptyState
          icon="lock"
          title="You can view this project, not add to it"
          actions={
            <Link className={buttonClass('secondary')} to={back.to}>
              Back to Dashboards
            </Link>
          }
        >
          Rebuilding a dashboard creates one. Ask a project editor for access.
        </EmptyState>
      </Page>
    );
  }
  if (!list.length) {
    return (
      <Page back={back} title={title} sub={sub}>
        <EmptyState
          icon="database"
          title="Bring your data in first"
          actions={
            <Link className={buttonClass('primary')} to={`/data/import?project=${projectId}`}>
              Import data
            </Link>
          }
        >
          A screenshot gives the layout; your dataset gives every figure. Import the data the dashboard was built on, then come back.
        </EmptyState>
      </Page>
    );
  }

  const datasetPicker = (
    <Select
      label="Build it on"
      value={datasetId}
      options={list.map((d) => ({ value: d.id, label: d.name || 'Untitled' }))}
      onValueChange={setPicked}
      className={s.dsPick}
    />
  );

  if (reading && shot) {
    return (
      <RebuildCheck
        projectId={projectId}
        shot={shot}
        reading={reading}
        match={match}
        overrides={overrides}
        lit={lit}
        onLight={setLit}
        onChange={change}
        datasetPicker={datasetPicker}
        name={name ?? (match.data?.ok ? match.data.name : '')}
        onName={setName}
        building={building}
        onCreate={() => void create()}
        onRestart={restart}
        back={back}
      />
    );
  }

  return (
    <Page back={back} title={title} sub={sub}>
      <div className={s.layout}>
        <div className={s.left}>
          {shot ? (
            <section className={s.shotCard} aria-label="Screenshot">
              <RebuildShot src={shot} tiles={[]} lit={null} onLight={() => {}} scanning={busy} />
            </section>
          ) : (
            <DropZone
              icon="layout-dashboard"
              title="Drop a dashboard screenshot, or paste one"
              hint="A whole dashboard reads best — uncropped, at the size you would read it. PNG, JPEG, WebP or GIF. Ctrl+V / ⌘V pastes from the clipboard."
              accept="image/*"
              choose="Choose a screenshot"
              onFile={(f) => void take(f)}
            />
          )}
        </div>
        <div className={s.right}>
          {busy ? (
            <Reading />
          ) : failed ? (
            <section className={s.failure} role="alert">
              <span className={s.failureIcon}>
                <Icon name="camera" size={24} />
              </span>
              <h2 className={s.failureTitle}>That screenshot could not be rebuilt</h2>
              <p className={s.failureMsg}>{failed.message}</p>
              {failed.detail && <code className={s.failureDetail}>{failed.detail}</code>}
              <Button variant="primary" icon="refresh" onClick={restart}>
                Try another screenshot
              </Button>
            </section>
          ) : (
            <section className={s.card} aria-label="How it works">
              <h2 className={s.label}>How it works</h2>
              <ol className={s.how}>
                {HOW.map(([icon, head, body]) => (
                  <li key={head} className={s.howStep}>
                    <span className={s.howIcon} aria-hidden="true">
                      <Icon name={icon} size={16} />
                    </span>
                    <span>
                      <strong className={s.howHead}>{head}</strong>
                      <span className={s.howBody}>{body}</span>
                    </span>
                  </li>
                ))}
              </ol>
              {datasetPicker}
            </section>
          )}
        </div>
      </div>
    </Page>
  );
}
