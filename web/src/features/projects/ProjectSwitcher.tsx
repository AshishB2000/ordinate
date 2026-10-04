// The project switcher — the top bar's project button and its popover
// (legacy projectSwitcher.ts). Each row says what is in the project and when
// it was last opened; its ⋯ carries Rename, Share, Export, Archive and Delete
// — each offered only to a role the server will allow. New project and Import
// project sit under the list; archived projects fold away with Restore.
// Switching is in place: the current project (./current.tsx) changes, and a
// page that belonged to the old one goes back to its section.

import { lazy, Suspense, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc, upload } from '../../api/client';
import { startDownload } from '../../api/files';
import { NAV } from '../../app/nav';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { Popover } from '../../ui/Popover';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useMe } from '../auth/api';
import { fmtOpened, plural, useRoles, type ProjectRow } from './api';
import { useCurrentProject } from './current';
import shell from '../../app/Shell.module.css';
import s from './Projects.module.css';

// The dialogs load on first use: the switcher is in the shell's initial chunk.
const NameDialog = lazy(() => import('./ProjectDialogs').then((m) => ({ default: m.NameDialog })));
const DeleteDialog = lazy(() => import('./ProjectDialogs').then((m) => ({ default: m.DeleteDialog })));
const ShareDialog = lazy(() => import('./ShareDialog').then((m) => ({ default: m.ShareDialog })));

const UUID_IN_PATH = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i;

/** The initial in a tinted square — a project's face in the switcher and the top bar. */
export function Avatar({ name, large }: { name: string; large?: boolean }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`${s.avatar} ${large ? s.avatarLg : ''}`} data-tint={h % 4} aria-hidden="true">
      {(name.trim()[0] || '?').toUpperCase()}
    </span>
  );
}

type Dialog =
  | { kind: 'new' }
  | { kind: 'rename'; p: ProjectRow }
  | { kind: 'delete'; p: ProjectRow }
  | { kind: 'share'; p: ProjectRow }
  | null;

/** Moves focus between the rows' main buttons with the arrow keys (as the legacy rows did). */
function onRowsKey(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-row]')];
  const i = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

export function ProjectSwitcher() {
  const cur = useCurrentProject();
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const here = useLocation();
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  // Asked when the popover or a dialog opens: the rows' actions depend on it.
  const roles = useRoles(open || dialog !== null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const orgRole = me.data?.user?.role;
  const canCreate = orgRole === 'admin' || orgRole === 'editor';
  const sharing = me.data?.accounts === true;
  const live = cur.projects.filter((p) => !p.archived);
  const archived = cur.projects.filter((p) => p.archived);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['projects:overview'] });
    void client.invalidateQueries({ queryKey: ['projects:roles'] });
    void client.invalidateQueries({ queryKey: ['projects:list'] });
  };

  /** Switch, and leave a page that belonged to the old project for its section. */
  const switchTo = (id: string) => {
    setOpen(false);
    if (id === cur.projectId) return;
    cur.select(id);
    if (UUID_IN_PATH.test(here.pathname)) {
      const section = '/' + here.pathname.split('/')[1];
      void navigate(NAV.some((n) => n.to === section) ? section : '/');
    }
  };

  const fail = (what: string, err: unknown) =>
    toast(`${what}: ${err instanceof Error && err.message !== 'forbidden' ? err.message : 'you do not have permission'}.`, { kind: 'error' });

  const exportOne = async (p: ProjectRow) => {
    setOpen(false);
    try {
      const r = (await rpc('projects:export', { id: p.id })) as { ok: boolean; downloadToken?: string; error?: string };
      if (!r.ok || !r.downloadToken) return void toast(r.error ?? 'The export failed.', { kind: 'error' });
      startDownload(r.downloadToken);
      toast(`Exported “${p.name}”.`, { kind: 'success' });
    } catch (err) {
      fail('The export failed', err);
    }
  };

  const archive = async (p: ProjectRow, on: boolean) => {
    setOpen(false);
    try {
      // Leave it first: the next most recently opened project becomes current.
      if (on && p.id === cur.projectId) {
        const next = live.find((x) => x.id !== p.id);
        if (next) switchTo(next.id);
      }
      await rpc('projects:archive', { id: p.id, archived: on });
      refresh();
      if (on) toast(`Archived “${p.name}”.`, { action: { label: 'Undo', onClick: () => void archive(p, false) } });
      else toast(`Restored “${p.name}”.`, { kind: 'success' });
    } catch (err) {
      fail(on ? 'It could not be archived' : 'It could not be restored', err);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const up = await upload(file, file.name);
      const r = (await rpc('projects:import', { fileToken: up.fileToken })) as {
        ok: boolean;
        error?: string;
        project?: { id: string; name: string };
        counts?: Record<string, number>;
      };
      if (!r.ok || !r.project) return void toast(r.error ?? 'That bundle could not be imported.', { kind: 'error' });
      refresh();
      switchTo(r.project.id);
      const c = r.counts ?? {};
      toast(
        `Imported “${r.project.name}” — ${plural(c.datasets ?? 0, 'dataset')}, ${plural(c.visuals ?? 0, 'visual')}, ${plural(c.dashboards ?? 0, 'dashboard')}.`,
        { kind: 'success' },
      );
    } catch (err) {
      fail('That bundle could not be imported', err);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const menuFor = (p: ProjectRow): MenuEntry[] => {
    const role = roles.data?.[p.id];
    const write = role === 'editor' || role === 'admin';
    const admin = role === 'admin';
    const items: MenuEntry[] = [];
    if (write) items.push({ label: 'Rename', icon: 'pencil', onSelect: () => setDialog({ kind: 'rename', p }) });
    if (sharing) items.push({ label: admin ? 'Share…' : 'Who has access', icon: 'user', onSelect: () => setDialog({ kind: 'share', p }) });
    items.push({ label: 'Export project', icon: 'package', onSelect: () => void exportOne(p) });
    if (admin) {
      items.push({
        // The last open project cannot be archived: there would be nowhere to be.
        label: live.length > 1 ? 'Archive' : 'Archive (the only project)',
        icon: 'archive',
        disabled: live.length <= 1,
        onSelect: () => void archive(p, true),
      });
      items.push({ kind: 'separator' }, { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'delete', p }) });
    }
    return items;
  };

  const name = cur.project?.name ?? (cur.status === 'pending' ? 'Loading…' : 'No project');
  let body;
  if (cur.status === 'pending') body = <SkeletonRows rows={3} label="Loading projects" />;
  else if (cur.status === 'error') {
    body = <ErrorState compact heading={3} title="Projects could not be loaded" message={cur.error?.message ?? ''} onRetry={cur.refetch} />;
  } else if (live.length === 0) {
    body = (
      <p className={s.none}>
        {canCreate ? 'No projects yet. Create one to start bringing data in.' : 'Nothing has been shared with you yet. Ask a project admin to share a project.'}
      </p>
    );
  } else {
    body = (
      <div className={s.rows} role="list" onKeyDown={onRowsKey}>
        {live.map((p) => {
          const current = p.id === cur.projectId;
          return (
            <div key={p.id} role="listitem" className={`${s.row} ${current ? s.current : ''}`}>
              <button type="button" data-row className={s.rowMain} aria-current={current ? 'true' : undefined} onClick={() => switchTo(p.id)}>
                <Avatar name={p.name} large />
                <span className={s.rowText}>
                  <span className={s.rowTop}>
                    <span className={s.rowName}>{p.name}</span>
                    {p.sample && <span className={s.sample} title="Holds the bundled sample data">Sample</span>}
                  </span>
                  <span className={s.rowMeta}>
                    {plural(p.datasets, 'dataset')} · {plural(p.dashboards, 'dashboard')} · {fmtOpened(p.lastOpenedAt)}
                  </span>
                </span>
                {current && (
                  <span className={s.check}>
                    <Icon name="check" />
                  </span>
                )}
              </button>
              <Menu align="end" label={`${p.name} options`} trigger={<IconButton icon="more-horizontal" size="sm" label={`${p.name} options`} className={s.more} disabled={roles.isPending} />} items={menuFor(p)} />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        title="Projects"
        trigger={
          <button type="button" className={`${shell.project} ${s.trigger}`} aria-label={`Switch project (current: ${name})`} data-testid="project-switcher">
            {cur.project ? (
              <Avatar name={cur.project.name} />
            ) : (
              <span className={shell.projectAvatar}>
                <Icon name="folder" />
              </span>
            )}
            <span className={shell.projectName}>{name}</span>
            <Icon name="chevron-down" />
          </button>
        }
      >
        <div className={s.pop}>
          <div className={s.head}>
            <span className={s.headH}>Projects</span>
            {cur.status === 'success' && <span className={s.headN}>{live.length}</span>}
          </div>
          {body}
          {canCreate && (
            <div className={s.actions}>
              <button type="button" className={s.action} onClick={() => (setOpen(false), setDialog({ kind: 'new' }))}>
                <Icon name="plus" />
                New project
              </button>
              <button type="button" className={s.action} disabled={importing} onClick={() => fileInput.current?.click()}>
                <Icon name={importing ? 'loader' : 'upload'} />
                {importing ? 'Importing…' : 'Import project…'}
              </button>
            </div>
          )}
          {archived.length > 0 && (
            <>
              <button type="button" className={s.fold} aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
                <Icon name={showArchived ? 'chevron-down' : 'chevron-right'} size={12} />
                Archived ({archived.length})
              </button>
              {showArchived && (
                <div className={s.archived}>
                  {archived.map((p) => (
                    <div key={p.id} className={s.arow}>
                      <Avatar name={p.name} />
                      <span className={s.arowName}>{p.name}</span>
                      {roles.data?.[p.id] === 'admin' ? (
                        <Button size="sm" onClick={() => void archive(p, false)} aria-label={`Restore ${p.name}`}>
                          Restore
                        </Button>
                      ) : (
                        <Badge>Archived</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Popover>
      <input
        ref={fileInput}
        type="file"
        accept=".ordinate"
        hidden
        aria-label="Project bundle to import"
        onChange={(e) => void importFile(e.target.files?.[0])}
      />
      <Suspense fallback={null}>
        {dialog?.kind === 'new' && (
          <NameDialog
            title="New project"
            confirm="Create"
            initial=""
            onClose={() => setDialog(null)}
            run={async (n) => {
              const made = (await rpc('projects:create', { name: n || 'Untitled project' })) as { id: string; name: string } | null;
              if (!made?.id) throw new Error('the server did not create it');
              refresh();
              switchTo(made.id);
              toast(`Created “${made.name}”.`, { kind: 'success' });
            }}
          />
        )}
        {dialog?.kind === 'rename' && (
          <NameDialog
            title="Rename project"
            confirm="Rename"
            initial={dialog.p.name}
            onClose={() => setDialog(null)}
            run={async (n) => {
              if (!n || n === dialog.p.name) return;
              const r = await rpc('projects:rename', { id: dialog.p.id, name: n });
              if (!r) throw new Error('that project is gone');
              refresh();
            }}
          />
        )}
        {dialog?.kind === 'delete' && (
          <DeleteDialog
            project={dialog.p}
            onClose={() => setDialog(null)}
            onDeleted={() => {
              refresh();
              toast(`Deleted “${dialog.p.name}”.`, { kind: 'success' });
            }}
          />
        )}
        {dialog?.kind === 'share' && <ShareDialog project={dialog.p} admin={roles.data?.[dialog.p.id] === 'admin'} onClose={() => setDialog(null)} />}
      </Suspense>
    </>
  );
}
