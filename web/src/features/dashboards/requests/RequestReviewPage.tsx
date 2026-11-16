// A dashboard request's review page (docs/team-folders/00-design.md, "Dashboard requests"; src/server/requests): what a
// viewer asked for, each chart drawn with today's figures AS THE REVIEWER (`request:preview` computes them through the
// answer door, under the reviewer's own access — never figures the viewer saw), and exactly what approving makes: a
// visual per chart, and the dashboard — a new one, in a folder the reviewer may pick among the server's choices (the
// viewer's suggestion shown), or a sheet on the existing one the viewer named. Then Approve and publish (the dashboard
// opens), Edit (made as a draft, opened in the editor; the viewer is told when it is first published) or Decline with
// a note. A draft that already had unpublished edits is never published by an approval: the server says why.
//
// Only an approver gets here: an editor with Edit on every dataset the charts read. Anyone else is the server's
// refusal, shown as it is. A request already decided says how, and links to its dashboard. Every figure and word on a
// chart is the server's; this page formats nothing.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { rpc } from '../../../api/client';
import { Page, PageSkeleton } from '../../../app/blocks';
import { ago } from '../../../app/when';
import { Chart } from '../../../charts/Chart';
import type { ChartDataShape } from '../../../charts/types';
import { Button, buttonClass } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Textarea } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { EmptyState, ErrorState } from '../../../ui/States';
import { ME_KEY } from '../../auth/api';
import { MENTIONS_KEY } from '../mentionsApi';
import s from './RequestReview.module.css';

/** `fewerRows`: the server's line when a row rule holds the requester to other rows than yours here (never their figures). */
type CardView = { ok: true; title: string; chartType: string; datasetName: string; data: ChartDataShape; headline: { label: string; display: string }[]; caption: string; notes: string[]; filterLabels: string[]; fewerRows?: string } | { ok: false; reason: string };
interface RequestView {
  projectId: string;
  id: string;
  by: string;
  title: string;
  note: string;
  charts: number;
  state: 'open' | 'drafted' | 'approved' | 'declined' | 'withdrawn';
  decidedBy: string;
  answer: string;
  dashboardId: string | null;
  onto?: boolean;
  at: string;
}
interface Creates {
  visuals: string[];
  dashboard: string;
  folder: string;
  folderId?: string;
  /** An existing dashboard: the sheet the charts go on, and whether Approve and publish publishes it. */
  onto?: { sheet: string; publishes: boolean };
}
interface Choice {
  id: string;
  name: string;
}
type Preview =
  | { ok: true; request: RequestView; cards: CardView[]; creates: Creates | null; choices?: Choice[]; suggested?: string; problem?: string }
  | { ok: false; error: string };
type Decided = { ok: true; dashboardId?: string; published?: boolean; why?: string } | { ok: false; error: string };

const BACK = { to: '/', label: 'Home' };
const charts = (n: number): string => (n === 1 ? '1 chart' : `${n} charts`);

export default function RequestReviewPage() {
  const { projectId = '', requestId = '' } = useParams();
  const q = useQuery({
    queryKey: ['request:preview', projectId, requestId],
    queryFn: async () => (await rpc('request:preview', { projectId, id: requestId })) as Preview,
    retry: false,
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <Page title="Dashboard request" back={BACK}>
        <ErrorState title="This request can’t be reviewed here" message={q.error.message} onRetry={() => void q.refetch()} />
      </Page>
    );
  }
  if (!q.data.ok) {
    return (
      <Page title="Dashboard request" back={BACK}>
        <EmptyState icon="layout-dashboard" title="No such request">
          {q.data.error}
        </EmptyState>
      </Page>
    );
  }
  return <Review preview={q.data} onDecided={() => void q.refetch()} />;
}

function Review({ preview, onDecided }: { preview: Extract<Preview, { ok: true }>; onDecided: () => void }) {
  const { request: r, cards, creates, choices = [], suggested = '' } = preview;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'publish' | 'draft' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [folderId, setFolderId] = useState(creates?.folderId ?? '');
  const told = () => {
    void qc.invalidateQueries({ queryKey: MENTIONS_KEY });
    void qc.invalidateQueries({ queryKey: ME_KEY });
  };
  const blocked = cards.some((c) => !c.ok) || !!preview.problem;
  const picking = !!creates && !creates.onto && choices.length > 1;
  const folder = choices.find((c) => c.id === folderId)?.name ?? creates?.folder ?? '';

  async function approve(publish: boolean): Promise<void> {
    setBusy(publish ? 'publish' : 'draft');
    setProblem(null);
    try {
      const moved = picking && folderId && folderId !== creates?.folderId ? { folderId } : {}; // only a change: the default is the server's
      const d = (await rpc('request:approve', { projectId: r.projectId, id: r.id, publish, ...moved })) as Decided;
      if (!d.ok || !d.dashboardId) return setProblem(d.ok ? 'Could not make the dashboard.' : d.error);
      told();
      if (d.why) toast(d.why);
      void navigate(d.published ? `/dashboards/${r.projectId}/${d.dashboardId}` : `/analyses/${r.projectId}/${d.dashboardId}`);
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'Could not approve the request.');
    } finally {
      setBusy(null);
    }
  }

  const actions = r.state === 'open' && (
    <>
      <Button variant="ghost" disabled={busy !== null} onClick={() => setDeclining(true)}>
        Decline…
      </Button>
      <Button variant="secondary" icon="pencil" loading={busy === 'draft'} disabled={busy !== null || blocked} onClick={() => void approve(false)}>
        Edit
      </Button>
      <Button variant="primary" icon="check" loading={busy === 'publish'} disabled={busy !== null || blocked} onClick={() => void approve(true)}>
        Approve and publish
      </Button>
    </>
  );
  return (
    <Page
      title={r.title}
      back={BACK}
      status={<StateChip state={r.state} />}
      sub={
        <span>
          <span className={s.strong}>{r.by}</span> asked for a dashboard {ago(r.at)} · {charts(r.charts)}
        </span>
      }
      actions={actions || undefined}
    >
      {(problem || preview.problem) && (
        <p className={s.problem} role="alert" data-testid="request-problem">
          <Icon name="alert" size={16} />
          {problem || preview.problem}
        </p>
      )}
      <div className={s.layout}>
        <div className={s.main}>
          {r.state !== 'open' ? (
            <Outcome r={r} />
          ) : (
            <ul className={s.cards} aria-label="The charts it asks for, with today’s figures">
              {cards.map((c, i) => (
                <li key={i} className={s.card} data-testid="request-card">
                  {c.ok ? <Drawn c={c} /> : <Undrawn reason={c.reason} />}
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside className={s.side} aria-label="About this request">
          <section className={s.panel}>
            <h2 className={s.panelTitle}>Note from {r.by}</h2>
            {r.note ? <p className={s.note}>{r.note}</p> : <p className={s.muted}>No note.</p>}
          </section>
          {creates && (
            <section className={s.panel} data-testid="request-creates">
              <h2 className={s.panelTitle}>Approving makes</h2>
              <ul className={s.makes}>
                <li>
                  <Icon name="chart-bar" size={16} />
                  <span>
                    {creates.visuals.length === 1 ? 'A visual' : `${creates.visuals.length} visuals`}: {creates.visuals.join(', ')}
                  </span>
                </li>
                <li>
                  <Icon name="layout-dashboard" size={16} />
                  {creates.onto ? (
                    <span>
                      A sheet <span className={s.strong}>{creates.onto.sheet}</span> on <span className={s.strong}>{creates.dashboard}</span>
                    </span>
                  ) : (
                    <span>
                      The dashboard <span className={s.strong}>{creates.dashboard}</span>
                    </span>
                  )}
                </li>
                <li>
                  <Icon name="folder" size={16} />
                  <span>
                    In <span className={s.strong}>{folder}</span>
                  </span>
                </li>
              </ul>
              {suggested && !creates.onto && (
                <p className={s.muted} data-testid="request-suggested">
                  {r.by} suggested <span className={s.strong}>{suggested}</span>.
                </p>
              )}
              {picking && <Select label="Folder" hint={`Folders you edit that ${r.by} can open.`} value={folderId} onValueChange={setFolderId} options={choices.map((c) => ({ value: c.id, label: c.name }))} />}
              <p className={s.muted}>
                {creates.onto && !creates.onto.publishes
                  ? `Its draft has edits nobody published: approving adds the charts to the draft and publishes nothing. ${r.by} is told when you publish it.`
                  : `Approve and publish shares it with ${r.by} at once. Edit opens it as a draft; ${r.by} is told when you publish it.`}
              </p>
            </section>
          )}
        </aside>
      </div>
      {declining && <DeclineDialog r={r} onClose={() => setDeclining(false)} onDone={() => { told(); onDecided(); }} />}
    </Page>
  );
}

function StateChip({ state }: { state: RequestView['state'] }) {
  const word = { open: 'Waiting for review', drafted: 'Being edited', approved: 'Approved', declined: 'Declined', withdrawn: 'Withdrawn' }[state];
  return <span className={`${s.chip} ${s[state]}`}>{word}</span>;
}

function Drawn({ c }: { c: Extract<CardView, { ok: true }> }) {
  return (
    <>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>{c.title}</h3>
        <span className={s.from}>
          <Icon name="database" size={12} />
          {c.datasetName}
        </span>
        {c.filterLabels.map((f) => (
          <span key={f} className={s.filter}>
            {f}
          </span>
        ))}
      </div>
      {c.headline.length > 0 && (
        <div className={s.kpis}>
          {c.headline.map((k) => (
            <div key={k.label} className={s.kpi}>
              <div className={s.kpiValue}>{k.display}</div>
              <div className={s.kpiLabel}>{k.label}</div>
            </div>
          ))}
        </div>
      )}
      <div className={s.chart}>
        <Chart type={c.chartType} data={c.data} label={c.title} />
      </div>
      {c.caption && <p className={s.caption}>{c.caption}</p>}
      {c.fewerRows && (
        <p className={s.fewer} role="note" data-testid="request-fewer-rows">
          <Icon name="lock" size={12} />
          <span>{c.fewerRows}</span>
        </p>
      )}
      {c.notes.map((n) => (
        <p key={n} className={s.muted}>
          {n}
        </p>
      ))}
    </>
  );
}

function Undrawn({ reason }: { reason: string }) {
  return (
    <div className={s.undrawn}>
      <Icon name="alert" size={16} />
      <span>
        <span className={s.strong}>This chart can’t be drawn now. </span>
        {reason} Nothing can be approved until it can; decline with a note instead.
      </span>
    </div>
  );
}

function Outcome({ r }: { r: RequestView }) {
  const by = r.decidedBy || 'An editor';
  if (r.state === 'withdrawn') {
    return (
      <div className={s.outcome}>
        <Icon name="undo" size={20} />
        <div>
          <p className={s.outcomeHead}>{r.by} withdrew it</p>
          <p className={s.muted}>Nothing was made.</p>
        </div>
      </div>
    );
  }
  if (r.state === 'declined') {
    return (
      <div className={s.outcome}>
        <Icon name="x" size={20} />
        <div>
          <p className={s.outcomeHead}>{by} declined it</p>
          {r.answer && <p className={s.note}>{r.answer}</p>}
        </div>
      </div>
    );
  }
  const draft = r.state === 'drafted';
  return (
    <div className={s.outcome}>
      <Icon name="circle-check" size={20} />
      <div>
        <p className={s.outcomeHead}>{draft ? `${by} is editing it as a draft` : `${by} approved it`}</p>
        <p className={s.muted}>{draft ? `${r.by} is told when it is first published.` : `${r.by} was told, and can open it.`}</p>
      </div>
      {r.dashboardId && (
        <Link className={buttonClass('secondary', 'md', s.outcomeGo)} to={draft ? `/analyses/${r.projectId}/${r.dashboardId}` : `/dashboards/${r.projectId}/${r.dashboardId}`}>
          {draft ? 'Open the draft' : 'Open the dashboard'}
          <Icon name="arrow-right" size={16} />
        </Link>
      )}
    </div>
  );
}

function DeclineDialog({ r, onClose, onDone }: { r: RequestView; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function decline(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const d = (await rpc('request:decline', { projectId: r.projectId, id: r.id, note: note.trim() })) as Decided;
      if (!d.ok) return setProblem(d.error);
      onDone();
      onClose();
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'Could not decline the request.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Decline this request"
      description={`${r.by} gets your note in their notifications. Nothing is made.`}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="danger" loading={busy} disabled={!note.trim()} onClick={() => void decline()}>
            Decline
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Textarea label="Note to the viewer" hint="Why not, or where they can find it instead." rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} required />
        {problem && (
          <p className={s.problem} role="alert">
            <Icon name="alert" size={16} />
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}
