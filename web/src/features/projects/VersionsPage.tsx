// Version history of one record (legacy versionsPanel.ts), at
// /versions/:projectId/:type/:id — the address a record page's History button
// links to (T2.3 datasets, T2.7 visuals, T2.8 dashboards, …). Every save of a
// dashboard, visual, metric, report or dataset pipeline is a version (at most
// 50); picking one previews it read-only, and Restore saves it again as the
// newest version — history stays append-only, so undoing a restore is
// restoring the version before it.

import { useState } from 'react';
import { useParams } from 'react-router';
import { Page } from '../../app/blocks';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonBlock, SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { fmtDay, fmtTime, fmtWhen, plural, useCan, useChange, useVersion, useVersions, type VersionMeta, type VersionType } from './api';
import { useAdoptProject } from './current';
import { LayoutThumb, VersionPreview } from './VersionPreview';
import s from './Versions.module.css';

const WORD: Record<VersionType, string> = { dashboard: 'Dashboard', visual: 'Visual', metric: 'Metric', report: 'Report', dataset: 'Pipeline' };
const isType = (t: string | undefined): t is VersionType => !!t && Object.prototype.hasOwnProperty.call(WORD, t);

export default function VersionsPage() {
  const { projectId = '', type, id = '' } = useParams();
  useAdoptProject(projectId);
  if (!isType(type)) {
    return (
      <Page title="Version history">
        <EmptyState icon="history" title="No history here">
          Dashboards, visuals, metrics, reports and dataset pipelines keep a version history. This address names none of them.
        </EmptyState>
      </Page>
    );
  }
  return <History projectId={projectId} type={type} id={id} />;
}

function Row({ v, current, selected, type, onPick }: { v: VersionMeta; current: boolean; selected: boolean; type: VersionType; onPick: () => void }) {
  return (
    <button
      type="button"
      className={`${s.row} ${selected ? s.selected : ''} ${current ? s.isCurrent : ''}`}
      aria-pressed={selected}
      aria-label={`${fmtWhen(v.savedAt)}${current ? ', current' : ''}: ${v.summary}`}
      onClick={onPick}
    >
      {type === 'dashboard' ? <LayoutThumb tiles={v.thumb ?? []} /> : <span className={s.dot} aria-hidden="true" />}
      <span className={s.rowMain}>
        <span className={s.rowTop}>
          <span className={s.when}>{fmtTime(v.savedAt)}</span>
          {current && <span className={s.badge}>Current</span>}
        </span>
        <span className={s.summary}>{v.summary}</span>
        {v.restoredFrom && (
          <span className={s.restored}>
            <Icon name="rotate-ccw" size={12} />
            Restored from {fmtWhen(v.restoredFrom)}
          </span>
        )}
      </span>
    </button>
  );
}

function History({ projectId, type, id }: { projectId: string; type: VersionType; id: string }) {
  const list = useVersions(projectId, type, id);
  const can = useCan(projectId);
  const [sel, setSel] = useState<string | null>(null);
  const versions = list.data ?? [];
  const newest = versions[0];
  const picked = versions.find((v) => v.key === sel) ?? newest;
  const latest = useVersion(projectId, type, id, newest?.key);
  const preview = useVersion(projectId, type, id, picked?.key);
  const restore = useChange<'versions:restore', { ok: boolean; error?: string; unchanged?: boolean }>(
    'versions:restore',
    ['versions:list', 'versions:get', 'trash:list'],
    (r) => {
      if (!r.ok) return void toast(r.error ?? 'Could not restore that version.', { kind: 'error' });
      toast(r.unchanged ? 'That version is already the current one.' : `Restored the version from ${picked ? fmtWhen(picked.savedAt) : 'then'} — the one before it is still here.`, {
        kind: 'success',
      });
      setSel(null);
    },
  );

  const name = typeof latest.data?.record.name === 'string' ? latest.data.record.name : '';
  const title = name || WORD[type];
  const viewingOld = !!picked && picked !== newest;

  let left;
  let right = null;
  if (list.isPending) {
    left = <SkeletonRows rows={6} label="Loading the history" />;
    right = <SkeletonBlock label="Loading the version" />;
  } else if (list.isError) {
    left = <ErrorState heading={3} title="The history could not be loaded" message={list.error.message} onRetry={() => void list.refetch()} />;
  } else if (versions.length === 0) {
    left = (
      <EmptyState heading={3} icon="history" title="No saved versions yet">
        Every save from now on is kept here, up to 50, and any of them can be brought back.
      </EmptyState>
    );
  } else {
    left = (
      <div className={s.list}>
        {versions.map((v, i) => {
          const d = fmtDay(v.savedAt);
          return (
            <div key={v.key} className={s.item}>
              {(i === 0 || fmtDay(versions[i - 1].savedAt) !== d) && <h3 className={s.day}>{d}</h3>}
              <Row v={v} current={i === 0} selected={v === picked} type={type} onPick={() => setSel(i === 0 ? null : v.key)} />
            </div>
          );
        })}
        <p className={s.foot}>{versions.length >= 50 ? 'The 50 most recent saves are kept.' : `${plural(versions.length, 'save')} kept · up to 50`}</p>
      </div>
    );
    let content;
    if (preview.isPending) content = <SkeletonBlock label="Loading the version" />;
    else if (preview.isError) {
      content = <ErrorState compact heading={3} title="That version could not be read" message={preview.error.message} onRetry={() => void preview.refetch()} />;
    } else if (!preview.data) content = <ErrorState compact heading={3} title="That version could not be read" message="It may have been removed with its record." />;
    else content = <VersionPreview type={type} record={preview.data.record} meta={picked} />;
    right = (
      <>
        <div className={`${s.banner} ${viewingOld ? '' : s.bannerCurrent}`} role="status">
          <span className={s.bannerIc}>
            <Icon name="history" />
          </span>
          <span className={s.bannerText}>
            <strong>{viewingOld && picked ? `Viewing version from ${fmtWhen(picked.savedAt)}` : 'The current version'}</strong>
            <span>
              {picked?.summary}
              {viewingOld ? ' · read-only' : ''}
            </span>
          </span>
          {viewingOld && picked && (
            <span className={s.bannerActions}>
              {can('editor') && (
                <Button
                  size="sm"
                  variant="primary"
                  icon="rotate-ccw"
                  loading={restore.isPending}
                  onClick={() => restore.mutate({ projectId, type, id, key: picked.key })}
                >
                  Restore
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSel(null)}>
                Back to current
              </Button>
            </span>
          )}
        </div>
        {content}
      </>
    );
  }

  return (
    <Page title={`${title} — version history`} sub={`${WORD[type]} history. Every save is a version; restoring one saves it again as the newest, so nothing is lost.`}>
      <div className={s.layout}>
        <section className={s.side} aria-label="Saved versions">
          <div className={s.sideHead}>
            <Badge icon="history">{WORD[type]}</Badge>
          </div>
          {left}
        </section>
        <section className={s.preview} aria-label="Version preview">
          {right}
        </section>
      </div>
    </Page>
  );
}
