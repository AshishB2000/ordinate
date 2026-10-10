// "Why did this change?" — the KEY DRIVERS answer (driversPanel.ts): the
// change as a headline with its two periods, the dimensions ranked by how much
// of it they explain, the chosen one as a waterfall (start, the top movers up
// and down, Other, end), the app's caption, and the actions. A contributor
// drills one level down (West → state); the breadcrumb climbs back.
//
// NOTHING HERE COMPUTES A FIGURE: every number and sentence arrives from
// `drivers:explain` already written, each waterfall step with the level it
// starts from. Exported for the other doors (a KPI card's "Why?", a line
// chart's point) to open with their own question.

import { useState, type ReactNode } from 'react';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { EmptyState, ErrorState } from '../../../ui/States';
import { Skeleton } from '../../../ui/Skeleton';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import { openDockWith } from '../../assistant/dockState';
import { call, useDrivers, type DriversRequest, type DriversResult, type MemberView } from '../api';
import { fmtPct } from '../format';
import s from './Drivers.module.css';

type Tone = 'good' | 'bad' | 'flat';

/** Good or bad news by the metric's direction (up is good unless it says otherwise). */
function toneOf(r: DriversResult, delta: number): Tone {
  if (!delta) return 'flat';
  return (r.metric.direction === 'down_good' ? delta < 0 : delta > 0) ? 'good' : 'bad';
}

/** A member's weight in words — its share of the change, or of all movement when members offset. */
function shareText(st: MemberView, offsetting: boolean): string | undefined {
  if (st.share === null || st.share === undefined) return undefined;
  if (offsetting || Math.abs(st.share) > 200) return `${Math.round(st.moveShare)}% of all movement`;
  const pct = Math.round(st.share);
  return `${pct < 0 ? '−' + Math.abs(pct) : String(pct)}% of the change`;
}

function Loading() {
  return (
    <div className={s.body} aria-busy="true" role="status" aria-label="Explaining the change">
      <div className={s.dims}>
        <div className={s.secH}>Dimensions</div>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className={s.skelDim} />
        ))}
      </div>
      <div className={s.main}>
        <Skeleton className={s.skelCaption} />
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className={s.skelBar} />
        ))}
      </div>
    </div>
  );
}

function Waterfall({ r, onDrill }: { r: DriversResult; onDrill: ((key: string) => void) | null }) {
  const sel = r.selected!;
  const w = sel.waterfall;
  const ratio = r.metric.kind === 'ratio';
  type Row = { label: string; from: number; to: number; delta: number; text: string; kind: 'total' | 'step' | 'other'; key?: string; sub?: string };
  const rows: Row[] = [{ label: r.periods.b, from: 0, to: w.start, delta: 0, text: w.startText, kind: 'total' }];
  for (const st of w.steps) {
    rows.push({
      label: st.label,
      from: st.from,
      to: st.to,
      delta: st.delta,
      text: st.deltaText,
      kind: 'step',
      key: st.key,
      sub: ratio && st.mixText !== undefined ? `Mix ${st.mixText} · Rate ${st.rateText}` : shareText(st, sel.offsetting),
    });
  }
  if (w.other.count > 0) rows.push({ label: `Other (${w.other.count})`, from: w.other.from, to: w.other.to, delta: w.other.delta, text: w.other.deltaText, kind: 'other' });
  rows.push({ label: r.periods.a, from: 0, to: w.end, delta: 0, text: w.endText, kind: 'total' });

  // The axis: from 0, unless every level sits far above it — then zoom in so the
  // steps are visible, and mark the totals as cut. Placement only.
  const levels = rows.flatMap((x) => (x.kind === 'total' ? [x.to] : [x.from, x.to]));
  let lo = Math.min(0, ...levels);
  const hi = Math.max(0, ...levels);
  const minLevel = Math.min(...levels);
  let cut = false;
  if (lo === 0 && minLevel > 0 && minLevel > 0.4 * hi) {
    lo = minLevel - (hi - minLevel) * 0.35;
    cut = true;
  }
  const span = hi - lo || 1;
  const pos = (v: number) => ((v - lo) / span) * 100;

  return (
    <div className={s.wf} role="list" aria-label="Waterfall of contributors">
      {rows.map((x, i) => {
        const tone = x.kind === 'total' ? null : toneOf(r, x.delta);
        const a = x.kind === 'total' ? pos(Math.max(lo, 0)) : pos(Math.min(x.from, x.to));
        const b = x.kind === 'total' ? pos(x.to) : pos(Math.max(x.from, x.to));
        const bar = [s.wfBar, x.kind === 'total' ? cut && s.isCut : tone && s[tone]].filter(Boolean).join(' ');
        const inner = (
          <>
            <span className={s.wfLabel}>
              <span className={s.wfName}>{x.label}</span>
              {x.sub && <span className={s.wfSub}>{x.sub}</span>}
            </span>
            <span className={s.wfTrack}>
              <span className={bar} style={{ left: `${Math.min(a, b)}%`, width: `${Math.max(0.6, Math.abs(b - a))}%` }} />
            </span>
            <span className={[s.wfVal, tone && s[tone]].filter(Boolean).join(' ')}>{x.text}</span>
          </>
        );
        const cls = [s.wfRow, s[x.kind]].join(' ');
        return onDrill && x.kind === 'step' ? (
          <button key={i} type="button" role="listitem" className={`${cls} ${s.drill}`} aria-label={`${x.label}: ${x.text}. Break it down further.`} onClick={() => onDrill(x.key as string)}>
            {inner}
          </button>
        ) : (
          <div key={i} role="listitem" className={cls}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/** The panel while its answer is on the way — also what another door shows while it asks its own question. */
export function DriversPending() {
  return (
    <div className={s.panel}>
      <Header title="Explaining the change…" />
      <Loading />
    </div>
  );
}

/** The answer to one drivers question; the user's next questions (a dimension, a drill, a crumb) are asked here. */
export function DriversView({
  projectId,
  request,
  readOnly,
  actions,
}: {
  projectId: string;
  request: DriversRequest;
  /** A viewer's panel: nothing that saves ("Add as a waterfall tile" writes a visual). */
  readOnly?: boolean;
  /** More footer actions for the answer on screen (a door's "Open in Analytics"). */
  actions?: (r: DriversResult) => ReactNode;
}) {
  // The question on screen: the caller's, then the server's echo of it with the user's next step.
  const [asked, setAsked] = useState<{ base: DriversRequest; next: DriversRequest }>({ base: request, next: request });
  const current = asked.base === request ? asked.next : request;
  const q = useDrivers(projectId, current);
  const again = (r: DriversResult, patch: Partial<DriversRequest>) => {
    const next: DriversRequest = { ...r.spec, ...(request.params ? { params: request.params } : {}), ...patch };
    if (patch.path) delete next.dimension; // a new level picks its own best dimension
    setAsked({ base: request, next });
  };

  if (q.isPending || q.isFetching) return <DriversPending />;
  const r = q.data;
  if (!r || !r.ok) {
    return (
      <div className={s.panel}>
        <Header title="Nothing to explain yet" />
        <div className={s.state}>
          <ErrorState title="This change cannot be explained" message={r && !r.ok ? r.error : 'Could not explain the change.'} onRetry={() => void q.refetch()} heading={3} />
        </div>
      </div>
    );
  }
  const sel = r.selected;
  const drillable = !!sel && r.dimensions.length > 1 && r.path.length < 4;
  const tone = typeof r.totals.delta === 'number' ? toneOf(r, r.totals.delta) : null;

  async function addTile() {
    if (!r || !r.ok || !r.selected) return;
    const name = `Why ${r.metric.name} changed, by ${r.selected.column}`;
    const res = await call<{ ok: true }>(rpc('drivers:addTile', { projectId, request: { ...r.spec, dimension: r.selected.column }, name }), 'Could not add the tile.');
    if (!res.ok) toast(res.error, { kind: 'error' });
    else toast(`Saved “${name}” to Visuals.`, { kind: 'success' });
  }
  function ask() {
    if (!r || !r.ok) return;
    const verb = typeof r.totals.delta === 'number' && r.totals.delta < 0 ? 'fall' : 'rise';
    openDockWith(`Why did ${r.metric.name} ${verb} from ${r.periods.b} to ${r.periods.a}?`);
  }

  return (
    <div className={s.panel}>
      {/* A chart point's question arrives with its whole sentence ("… fell 18% in Mar 2026 vs Feb 2026 (from … to …)"). */}
      <Header title={r.sentence || r.headline || r.metric.name}>
        <div className={s.periods}>
          <span className={s.period}>
            <span className={s.periodL}>{r.periods.b}</span>
            <span className={s.periodV}>{r.totals.bText}</span>
          </span>
          <span className={s.periodArrow} aria-hidden="true">
            <Icon name="arrow-right" />
          </span>
          <span className={`${s.period} ${s.isAfter}`}>
            <span className={s.periodL}>{r.periods.a}</span>
            <span className={s.periodV}>{r.totals.aText}</span>
          </span>
          {tone && (
            <span className={`${s.pill} ${s[tone]}`}>
              {r.totals.deltaText}
              {typeof r.totals.pct === 'number' && r.metric.kind !== 'ratio' ? ` (${fmtPct(r.totals.pct)})` : ''}
            </span>
          )}
        </div>
        {r.path.length > 0 && (
          <nav className={s.crumbs} aria-label="Breakdown path">
            <button type="button" className={s.crumb} onClick={() => again(r, { path: [] })}>
              {`All ${r.metric.name}`}
            </button>
            {r.path.map((p, i) => (
              <span key={p.column} className={s.crumbItem}>
                <Icon name="chevron-right" />
                {i === r.path.length - 1 ? (
                  <span className={`${s.crumb} ${s.isCurrent}`} aria-current="page">{`${p.column}: ${p.label}`}</span>
                ) : (
                  <button type="button" className={s.crumb} onClick={() => again(r, { path: r.path.slice(0, i + 1).map((x) => ({ column: x.column, value: x.value })) })}>
                    {`${p.column}: ${p.label}`}
                  </button>
                )}
              </span>
            ))}
          </nav>
        )}
      </Header>
      <div className={s.body}>
        <div className={s.dims}>
          <div className={s.secH}>
            Dimensions <span className={s.secSub}>ranked by explained variance</span>
          </div>
          {r.dimensions.length === 0 ? (
            <p className={s.dimsNone}>No dimension here has between 2 and 200 values.</p>
          ) : (
            <div className={s.dimList} role="group" aria-label="Break the change down by">
              {r.dimensions.map((d) => {
                const on = d.column === sel?.column;
                const pct = Math.round(d.explained * 100);
                return (
                  <button
                    key={d.column}
                    type="button"
                    className={on ? `${s.dim} ${s.isOn}` : s.dim}
                    aria-pressed={on}
                    aria-label={`${d.column}: explains ${pct}% of the change`}
                    onClick={() => !on && again(r, { dimension: d.column })}
                  >
                    <span className={s.dimTop}>
                      <span className={s.dimName}>{d.column}</span>
                      <span className={s.dimPct}>{`${pct}%`}</span>
                    </span>
                    <span className={s.dimTrack}>
                      <span className={s.dimFill} style={{ width: `${Math.max(2, pct)}%` }} />
                    </span>
                    <span className={s.dimSub}>{`${d.memberCount} members${d.lead ? ` · led by ${d.lead}` : ''}`}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <section className={s.main} aria-label="Contributors">
          {r.caption && (
            <div className={s.caption}>
              <Icon name="sparkles" />
              <span className={s.captionText}>{r.caption}</span>
              <span className={s.prov}>app-computed</span>
            </div>
          )}
          {!sel ? (
            <EmptyState icon="info" title="No breakdown for this change" heading={3}>
              {r.unavailable || 'Nothing in these periods to break down.'}
            </EmptyState>
          ) : (
            <>
              <div className={s.secH}>
                {`Contributors by ${sel.column}`}
                <span className={s.secSub}>{drillable ? 'select a member to break it down further' : 'largest moves first'}</span>
              </div>
              <Waterfall r={r} onDrill={drillable ? (key) => again(r, { path: [...r.path.map((p) => ({ column: p.column, value: p.value })), { column: sel.column, value: key }] }) : null} />
              {r.metric.kind === 'ratio' && (
                <p className={s.ratioNote}>
                  A ratio moves two ways: a member&apos;s MIX effect is its weight growing or shrinking, its RATE effect is its own ratio moving. Mix + rate = its contribution.
                </p>
              )}
            </>
          )}
        </section>
      </div>
      <footer className={s.foot}>
        <span className={s.footNote}>
          <Icon name="shield" />
          Every figure is computed by Ordinate from your data.
        </span>
        <div className={s.footActs}>
          {actions?.(r)}
          {!readOnly && (
            <Button icon="layout-dashboard" disabled={!sel} onClick={() => void addTile()}>
              Add as a waterfall tile
            </Button>
          )}
          <Button icon="sparkles" onClick={ask}>
            Ask the Assistant
          </Button>
        </div>
      </footer>
    </div>
  );
}

function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className={s.head}>
      <div className={s.eyebrow}>
        <Icon name="activity" />
        Why did this change?
      </div>
      <h2 className={s.title}>{title}</h2>
      {children}
    </header>
  );
}
