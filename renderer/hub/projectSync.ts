'use strict';

// Projects in a sync folder — the switcher's Move to sync folder… / Open from
// folder… / Move back, the warning before opening a project another Mac has
// open, and the banner for conflict copies the sync service left behind.
// Classic global-scope renderer <script>: no import/export. Main does the file
// work (src/ipc/syncFolder.ts); every path shown here came from main.

const SY_HERE = /Mac/i.test(navigator.platform) ? t('projectSync.this_mac') : t('projectSync.this_computer');

function syEl<T extends HTMLElement>(tag: string, cls?: string, text?: string): T {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** "Dropbox/Sales.ordinate-project" — the last two parts of a folder, enough to recognise it. */
function syShort(p: string): string {
  return String(p || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

/**
 * A small decision dialog: title, body lines, and two buttons. Resolves true
 * for the primary one. Esc, Cancel and the backdrop all resolve false.
 */
function syAsk(opts: { icon: string; tone?: 'warn'; title: string; body: string[]; meta?: string; ok: string; cancel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = syEl('div', 'ws-modal-overlay');
    const box = syEl('div', 'ws-modal sy-modal' + (opts.tone === 'warn' ? ' is-warn' : ''));
    const art = syEl('span', 'sy-modal-art');
    art.appendChild(icon(opts.icon, 20));
    box.append(art, syEl('div', 'ws-modal-title', opts.title));
    for (const line of opts.body) box.appendChild(syEl('p', 'sy-modal-p', line));
    if (opts.meta) box.appendChild(syEl('div', 'sy-modal-meta', opts.meta));
    const actions = syEl('div', 'ws-modal-actions');
    const no = syEl<HTMLButtonElement>('button', 'btn', opts.cancel || t('common.cancel'));
    const yes = syEl<HTMLButtonElement>('button', 'btn btn-primary', opts.ok);
    no.type = 'button';
    yes.type = 'button';
    actions.append(no, yes);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    const done = (v: boolean): void => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (a11y) a11y.release();
      resolve(v);
    };
    // Window, capturing: ahead of any panel underneath that also closes on Esc.
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } else if (a11y) a11y.onTabKey(e);
    }
    window.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
    no.addEventListener('click', () => done(false));
    yes.addEventListener('click', () => done(true));
    a11y = makeModalAccessible(box, opts.title, opts.tone === 'warn' ? no : yes);
  });
}

// ── Opening: the lock ────────────────────────────────────────────────────────

/**
 * Before a project is adopted: if it is synced and ANOTHER machine holds a
 * fresh lock, ask. "Open anyway" takes the lock over; Cancel keeps the user
 * where they are. A local project, a free lock or a stale one pass straight on.
 */
async function syConfirmOpen(id: string): Promise<boolean> {
  if (!window.hubBackup) return true;
  let st: any = null;
  try { st = await window.hubBackup.syncStatus(id); } catch (_) { return true; }
  if (!st || !st.synced || st.state !== 'held') return true;
  const since = st.openedAt ? new Date(st.openedAt) : null;
  const time = since ? since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    + (since.toDateString() === new Date().toDateString() ? '' : ' on ' + since.toLocaleDateString([], { month: 'short', day: 'numeric' })) : t('projectSync.a_moment_ago');
  const there = SY_HERE.replace('this', 'that');
  const ok = await syAsk({
    icon: 'cloud', tone: 'warn',
    title: st.name ? t('projectSync.is_open_somewhere_else', { name: st.name }) : t('projectSync.this_project_is_open_somewhere_else'),
    body: [t('projectSync.open_on_since_editing_here_too', { host: st.host, time }),
      t('projectSync.close_it_there_first_if_you', { there })],
    meta: t('projectSync.last_seen', { heartbeatAt: jpAgo(st.heartbeatAt), target: syShort(st.target) }),
    ok: t('projectSync.open_anyway'),
  });
  if (ok) await window.hubBackup.syncTake(id);
  return ok;
}

/** After a project is adopted: hold its lock, and say what there is to say. */
async function syAdopted(id: string): Promise<void> {
  if (!window.hubBackup) return;
  let r: any = null;
  try { r = await window.hubBackup.syncTake(id); } catch (_) { return; }
  for (const k of ['conflict', 'lost', 'offline']) syBannerClear(k);
  if (!r || !r.synced || id !== currentProjectId) return;
  if (!r.available) {
    syBanner('offline', 'alert', t('projectSync.this_project_s_sync_folder_is'),
      t('projectSync.ordinate_cannot_reach_check_that_icloud', { target: syShort(r.target) }), []);
    return;
  }
  if (r.tookOver) {
    showToast(t('projectSync.opened_here_last_had_it_open', { host: r.tookOver.host, heartbeatAt: jpAgo(r.tookOver.heartbeatAt) }), { kind: 'info' });
  }
  if (r.restart) syRestartNotice();
  if (r.conflicts && r.conflicts.length) syConflictBanner(id, r.conflicts);
}

function syRestartNotice(): void {
  syBanner('restart', 'info', t('projectSync.restart_ordinate_to_finish'),
    t('projectSync.the_data_engine_only_reads_the'),
    [{ label: t('projectSync.restart_now'), primary: true, run: () => void window.hubBackup.relaunch() }]);
}

// ── Banners ──────────────────────────────────────────────────────────────────

interface SyAction { label: string; primary?: boolean; run: () => void }

function syBannerClear(kind: string): void {
  document.querySelector(`.sy-banner[data-kind="${kind}"]`)?.remove();
}

function syBanner(kind: string, ic: string, title: string, text: string, actions: SyAction[], extra?: HTMLElement): HTMLElement {
  syBannerClear(kind);
  let host = document.getElementById('sy-banners');
  if (!host) {
    host = syEl('div', 'sy-banners');
    host.id = 'sy-banners';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const b = syEl('div', 'sy-banner');
  b.dataset.kind = kind;
  b.setAttribute('role', 'status');
  const art = syEl('span', 'sy-banner-ic');
  art.appendChild(icon(ic, 16));
  const body = syEl('div', 'sy-banner-body');
  body.append(syEl('div', 'sy-banner-t', title), syEl('div', 'sy-banner-d', text));
  if (extra) body.appendChild(extra);
  const acts = syEl('div', 'sy-banner-acts');
  for (const a of actions) {
    const btn = syEl<HTMLButtonElement>('button', 'btn btn-sm' + (a.primary ? ' btn-primary' : ''), a.label);
    btn.type = 'button';
    btn.addEventListener('click', a.run);
    acts.appendChild(btn);
  }
  const x = syEl<HTMLButtonElement>('button', 'btn btn-sm btn-ghost sy-banner-x');
  x.type = 'button';
  iconOnly(x, 'x', t('common.dismiss'));
  x.addEventListener('click', () => b.remove());
  acts.appendChild(x);
  b.append(art, body, acts);
  host.appendChild(b);
  return b;
}

function syConflictBanner(id: string, files: string[]): void {
  const list = syEl('ul', 'sy-files');
  for (const rel of files.slice(0, 6)) {
    const li = syEl('li', 'sy-file');
    li.appendChild(syEl('span', 'sy-file-name', rel));
    const reveal = syEl<HTMLButtonElement>('button', 'sy-link', t('common.reveal'));
    reveal.type = 'button';
    reveal.addEventListener('click', () => void window.hubBackup.revealConflict(id, rel));
    li.appendChild(reveal);
    list.appendChild(li);
  }
  if (files.length > 6) list.appendChild(syEl('li', 'sy-file sy-file-more', t('projectSync.and_more', { p0: files.length - 6 })));
  list.hidden = true;
  const b = syBanner('conflict', 'alert',
    t('projectSync.conflicting_in_this_project', { filesCount: files.length }),
    t('projectSync.your_sync_service_kept_both_versions'),
    [
      { label: t('common.details'), run: () => { list.hidden = !list.hidden; } },
      { label: t('common.reveal'), primary: true, run: () => void window.hubBackup.revealConflict(id, files[0]) },
    ], list);
  b.classList.add('is-warn');
}

// ── The switcher: badge, menu, actions ──────────────────────────────────────

/** The row's "Synced" badge, or null for a local project. */
function syBadge(p: any): HTMLElement | null {
  if (!p.syncedTo) return null;
  const b = syEl('span', 'pj-badge sy-badge');
  b.appendChild(icon('cloud', 11));
  b.appendChild(document.createTextNode(t('projectSync.synced')));
  b.title = t('projectSync.in', { syncedTo: p.syncedTo });
  return b;
}

/** The row menu's sync items, added through the switcher's own `item` builder. */
function syMenuItems(p: any, item: (ic: string, label: string, run: (() => void) | null) => void): void {
  if (p.syncedTo) {
    item('folder', t('projectSync.show_sync_folder'), () => void window.hubBackup.revealSyncFolder(p.id));
    item('hard-drive', t('projectSync.move_back_to', { SY_HERE }), () => void syMoveBack(p));
  } else {
    item('cloud', t('projectSync.move_to_sync_folder'), () => void syMoveTo(p));
  }
}

async function syMoveTo(p: any): Promise<void> {
  pjClose();
  const go = await syAsk({
    icon: 'cloud', title: t('projectSync.move_to_a_sync_folder', { name: p.name }),
    body: [t('projectSync.pick_a_folder_that_icloud_drive'),
      t('projectSync.edit_it_on_one_machine_at')],
    ok: t('projectSync.choose_folder'),
  });
  if (!go) return;
  const r = await window.hubBackup.moveToSyncFolder(p.id);
  if (!r || r.canceled) return;
  if (!r.ok) { showToast(r.error || t('projectSync.the_project_could_not_be_moved'), { kind: 'error' }); return; }
  showToast(t('projectSync.moved_to', { name: p.name, target: syShort(r.target) }), { kind: 'success', action: { label: t('common.show'), onClick: () => void window.hubBackup.revealSyncFolder(p.id) } });
  if (r.restart) syRestartNotice();
  if (p.id === currentProjectId) void syAdopted(p.id);
}

async function syMoveBack(p: any): Promise<void> {
  pjClose();
  const go = await syAsk({
    icon: 'hard-drive', title: t('projectSync.move_back_to_2', { name: p.name, SY_HERE }),
    body: [t('projectSync.ordinate_copies_it_into_its_own', { SY_HERE, syncedTo: syShort(p.syncedTo) }),
      t('projectSync.other_machines_that_open_it_from')],
    ok: t('projectSync.move_back'),
  });
  if (!go) return;
  const r = await window.hubBackup.moveBack(p.id);
  if (!r || !r.ok) { showToast((r && r.error) || t('projectSync.the_project_could_not_be_moved_2'), { kind: 'error' }); return; }
  syBannerClear('conflict');
  syBannerClear('lost');
  showToast(r.leftBehind ? t('projectSync.is_back_on_the_synced_folder', { name: p.name, SY_HERE })
    : t('projectSync.is_back_on', { name: p.name, SY_HERE }), { kind: 'success' });
}

async function syOpenFromFolder(): Promise<void> {
  pjClose();
  const r = await window.hubBackup.openFromFolder();
  if (!r || r.canceled) return;
  if (!r.ok || !r.project) { showToast(r.error || t('projectSync.that_folder_could_not_be_opened'), { kind: 'error' }); return; }
  await pjSwitchTo(String(r.project.id));
  showToast(t('projectSync.opened_from', { name: r.project.name, target: syShort(r.target) }), { kind: 'success' });
}

(function initProjectSync(): void {
  if (!window.hubBackup) return;
  window.hubBackup.onLockLost((info) => {
    if (!info || info.projectId !== currentProjectId) return;
    syBanner('lost', 'cloud', t('projectSync.also_opened_on', { host: info.host }),
      t('projectSync.changes_saved_on_both_machines_can'), []).classList.add('is-warn');
  });
})();
