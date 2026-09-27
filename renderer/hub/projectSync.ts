'use strict';

// Projects in a sync folder — the switcher's Move to sync folder… / Open from
// folder… / Move back, the warning before opening a project another Mac has
// open, and the banner for conflict copies the sync service left behind.
// Classic global-scope renderer <script>: no import/export. Main does the file
// work (src/ipc/syncFolder.ts); every path shown here came from main.

const SY_HERE = /Mac/i.test(navigator.platform) ? 'this Mac' : 'this computer';

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
    const no = syEl<HTMLButtonElement>('button', 'btn', opts.cancel || 'Cancel');
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
    + (since.toDateString() === new Date().toDateString() ? '' : ' on ' + since.toLocaleDateString([], { month: 'short', day: 'numeric' })) : 'a moment ago';
  const there = SY_HERE.replace('this', 'that');
  const ok = await syAsk({
    icon: 'cloud', tone: 'warn',
    title: st.name ? `“${st.name}” is open somewhere else` : 'This project is open somewhere else',
    body: [`Open on ${st.host} since ${time}. Editing here too can create conflicting copies.`,
      `Close it there first if you can. If ${there} is off or asleep, its lock expires within 5 minutes and this warning goes away.`],
    meta: `Last seen ${jpAgo(st.heartbeatAt)} · ${syShort(st.target)}`,
    ok: 'Open anyway',
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
    syBanner('offline', 'alert', 'This project’s sync folder is not available',
      `Ordinate cannot reach ${syShort(r.target)}. Check that iCloud Drive or Dropbox is running, then open the project again.`, []);
    return;
  }
  if (r.tookOver) {
    showToast(`Opened here — ${r.tookOver.host} last had it open ${jpAgo(r.tookOver.heartbeatAt)}, so its lock had expired.`, { kind: 'info' });
  }
  if (r.restart) syRestartNotice();
  if (r.conflicts && r.conflicts.length) syConflictBanner(id, r.conflicts);
}

function syRestartNotice(): void {
  syBanner('restart', 'info', 'Restart Ordinate to finish',
    'The data engine only reads the folders it was started with. Tables in this project come back after a restart.',
    [{ label: 'Restart now', primary: true, run: () => void window.hubBackup.relaunch() }]);
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
  iconOnly(x, 'x', 'Dismiss');
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
    const reveal = syEl<HTMLButtonElement>('button', 'sy-link', 'Reveal');
    reveal.type = 'button';
    reveal.addEventListener('click', () => void window.hubBackup.revealConflict(id, rel));
    li.appendChild(reveal);
    list.appendChild(li);
  }
  if (files.length > 6) list.appendChild(syEl('li', 'sy-file sy-file-more', `and ${files.length - 6} more`));
  list.hidden = true;
  const b = syBanner('conflict', 'alert',
    `${files.length} conflicting ${files.length === 1 ? 'copy' : 'copies'} in this project`,
    'Your sync service kept both versions when two machines saved at once. Compare them, keep the one you want, and delete the other.',
    [
      { label: 'Details', run: () => { list.hidden = !list.hidden; } },
      { label: 'Reveal', primary: true, run: () => void window.hubBackup.revealConflict(id, files[0]) },
    ], list);
  b.classList.add('is-warn');
}

// ── The switcher: badge, menu, actions ──────────────────────────────────────

/** The row's "Synced" badge, or null for a local project. */
function syBadge(p: any): HTMLElement | null {
  if (!p.syncedTo) return null;
  const b = syEl('span', 'pj-badge sy-badge');
  b.appendChild(icon('cloud', 11));
  b.appendChild(document.createTextNode('Synced'));
  b.title = 'In ' + p.syncedTo;
  return b;
}

/** The row menu's sync items, added through the switcher's own `item` builder. */
function syMenuItems(p: any, item: (ic: string, label: string, run: (() => void) | null) => void): void {
  if (p.syncedTo) {
    item('folder', 'Show sync folder', () => void window.hubBackup.revealSyncFolder(p.id));
    item('hard-drive', `Move back to ${SY_HERE}`, () => void syMoveBack(p));
  } else {
    item('cloud', 'Move to sync folder…', () => void syMoveTo(p));
  }
}

async function syMoveTo(p: any): Promise<void> {
  pjClose();
  const go = await syAsk({
    icon: 'cloud', title: `Move “${p.name}” to a sync folder`,
    body: ['Pick a folder that iCloud Drive or Dropbox keeps in sync. The project moves into it, and Ordinate on another machine can open it with Open from folder….',
      'Edit it on one machine at a time: Ordinate warns when it is already open somewhere else.'],
    ok: 'Choose folder…',
  });
  if (!go) return;
  const r = await window.hubBackup.moveToSyncFolder(p.id);
  if (!r || r.canceled) return;
  if (!r.ok) { showToast(r.error || 'The project could not be moved', { kind: 'error' }); return; }
  showToast(`Moved “${p.name}” to ${syShort(r.target)}`, { kind: 'success', action: { label: 'Show', onClick: () => void window.hubBackup.revealSyncFolder(p.id) } });
  if (r.restart) syRestartNotice();
  if (p.id === currentProjectId) void syAdopted(p.id);
}

async function syMoveBack(p: any): Promise<void> {
  pjClose();
  const go = await syAsk({
    icon: 'hard-drive', title: `Move “${p.name}” back to ${SY_HERE}`,
    body: [`Ordinate copies it into its own storage on ${SY_HERE}, then moves the folder in ${syShort(p.syncedTo)} to the Trash.`,
      'Other machines that open it from that folder will no longer see it.'],
    ok: 'Move back',
  });
  if (!go) return;
  const r = await window.hubBackup.moveBack(p.id);
  if (!r || !r.ok) { showToast((r && r.error) || 'The project could not be moved back', { kind: 'error' }); return; }
  syBannerClear('conflict');
  syBannerClear('lost');
  showToast(r.leftBehind ? `“${p.name}” is back on ${SY_HERE}. The synced folder could not be moved to the Trash — delete it yourself.`
    : `“${p.name}” is back on ${SY_HERE}`, { kind: 'success' });
}

async function syOpenFromFolder(): Promise<void> {
  pjClose();
  const r = await window.hubBackup.openFromFolder();
  if (!r || r.canceled) return;
  if (!r.ok || !r.project) { showToast(r.error || 'That folder could not be opened', { kind: 'error' }); return; }
  await pjSwitchTo(String(r.project.id));
  showToast(`Opened “${r.project.name}” from ${syShort(r.target)}`, { kind: 'success' });
}

(function initProjectSync(): void {
  if (!window.hubBackup) return;
  window.hubBackup.onLockLost((info) => {
    if (!info || info.projectId !== currentProjectId) return;
    syBanner('lost', 'cloud', `Also opened on ${info.host}`,
      'Changes saved on both machines can turn into conflicting copies. Close the project on one of them.', []).classList.add('is-warn');
  });
})();
