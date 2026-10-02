'use strict';

// Settings → General → BACKUPS, and the "Restore from backup…" dialog.
// Classic global-scope renderer <script>: no import/export. Reuses the row
// builders of settingsFormats.ts (sfRow, sfSeg, sfSelect) and the Jobs
// popover's jpAgo; talks to main through window.hubBackup (src/ipc/backups.ts).
//
// Main owns every value here: the folder comes from its native picker, and the
// status line is repainted from the view it pushes (`backups:changed`) and from
// the Jobs snapshot while a backup runs — this file never guesses a state.

let bkView: any = null;
let bkJob: { progress: number; note?: string } | null = null;

const BK_COUNT_WORDS: Array<[string, string]> = [
  ['datasets', 'dataset'], ['dashboards', 'dashboard'], ['visuals', 'visual'], ['metrics', 'metric'],
  ['stories', 'story'], ['reports', 'report'], ['alerts', 'alert'],
];

function bkPlural(n: number, one: string): string {
  return `${n.toLocaleString()} ${one === 'story' && n !== 1 ? 'stories' : one + (n === 1 ? '' : 's')}`;
}

/** "3 datasets · 2 dashboards · 5 visuals" — what a backup holds, from its manifest. */
function bkCounts(counts: Record<string, number>): string {
  const parts = BK_COUNT_WORDS.filter(([k]) => (counts[k] || 0) > 0).map(([k, one]) => bkPlural(counts[k], one));
  if ((counts.versions || 0) > 0) parts.push('history');
  return parts.length ? parts.join(' · ') : t('settingsBackups.an_empty_project');
}

function bkSize(bytes: number): string {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0) + ' MB';
}

/** "today at 9:05 AM", "tomorrow at 9:05 AM", "Thu, Oct 1 at 9:05 AM". */
function bkWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.getTime() <= now.getTime() + 60 * 1000) return t('settingsBackups.within_a_few_minutes');
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (that === day) return t('settingsBackups.today_at', { time });
  if (that - day === 86400000) return t('settingsBackups.tomorrow_at', { time });
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' at ' + time;
}

function bkBtn(label: string, cls: string, ic?: string): HTMLButtonElement {
  const b = sfEl<HTMLButtonElement>('button', 'btn btn-sm ' + cls);
  b.type = 'button';
  if (ic) iconLabel(b, ic, label); else b.textContent = label;
  return b;
}

// ── The section ──────────────────────────────────────────────────────────────

function buildBackupsSection(host: HTMLElement): void {
  host.textContent = '';
  const head = sfEl('div', 'stp-subhead');
  head.appendChild(sfEl('div', 'stp-subhead-t', t('settingsBackups.backups')));
  head.appendChild(sfEl('div', 'stp-subhead-d',
    t('settingsBackups.every_project_saved_as_a_ordinate')));
  host.appendChild(head);

  const card = sfEl('div', 'bk-card');
  card.id = 'bk-card';
  const tile = sfEl('span', 'bk-tile');
  tile.appendChild(icon('hard-drive', 18));
  const body = sfEl('div', 'bk-card-body');
  body.append(sfEl('div', 'bk-card-title'), sfEl('div', 'bk-card-sub'));
  const bar = sfEl('div', 'bk-bar');
  bar.appendChild(sfEl('span', 'bk-bar-fill'));
  const err = sfEl('div', 'bk-card-err');
  err.setAttribute('role', 'status');
  body.append(bar, err);
  const now = bkBtn(t('settingsBackups.back_up_now'), 'btn-primary bk-now', 'hard-drive');
  now.id = 'bk-now';
  now.addEventListener('click', () => void bkBackUpNow());
  card.append(tile, body, now);
  host.appendChild(card);

  const path = sfEl('div', 'bk-path');
  path.id = 'bk-path';
  const choose = bkBtn(t('common.choose'), 'bk-choose');
  choose.id = 'bk-choose';
  choose.addEventListener('click', async () => {
    const r = await window.hubBackup.chooseFolder();
    if (r && r.ok) { bkPaint(r.settings); showToast(t('settingsBackups.backups_will_go_to', { folder: r.settings.folder }), { kind: 'success' }); }
  });
  const reveal = sfEl<HTMLButtonElement>('button', 'btn btn-sm btn-ghost bk-reveal');
  reveal.type = 'button';
  iconOnly(reveal, 'external-link', t('settingsBackups.show_the_backup_folder'));
  reveal.addEventListener('click', async () => {
    const r = await window.hubBackup.revealFolder();
    if (r && !r.ok) showToast(r.error || t('settingsBackups.the_folder_could_not_be_opened'), { kind: 'error' });
  });
  const reset = sfEl<HTMLButtonElement>('button', 'bk-link bk-default', t('settingsBackups.use_default'));
  reset.type = 'button';
  reset.id = 'bk-default';
  reset.addEventListener('click', async () => bkPaint(await window.hubBackup.useDefaultFolder()));
  const folderRow = sfRow(t('common.folder'), '', choose, reveal);
  folderRow.querySelector('.stp-rl')!.append(path, reset);
  host.appendChild(folderRow);

  host.appendChild(sfRow(t('common.schedule'), t('settingsBackups.checked_every_few_minutes_while_ordinate'),
    sfSeg('bk-cadence', [['off', t('common.off')], ['daily', t('settingsBackups.daily')], ['weekly', t('common.weekly')]],
      async (v) => bkPaint(await window.hubBackup.set({ cadence: v })))));

  const keep = sfSelect('bk-keep', [3, 5, 7, 14, 30].map((n) => [String(n), t('settingsBackups.per_project', { n })] as [string, string]),
    async (v) => bkPaint(await window.hubBackup.set({ keep: Number(v) })));
  host.appendChild(sfRow(t('settingsBackups.keep'), t('settingsBackups.the_newest_scheduled_backups_of_each'), keep));

  const restore = bkBtn(t('settingsBackups.restore_from_backup'), 'bk-restore-open', 'rotate-ccw');
  restore.id = 'bk-restore-open';
  restore.addEventListener('click', () => void bkOpenRestore());
  host.appendChild(sfRow(t('common.restore'), t('settingsBackups.bring_a_backup_back_as_a'), restore));
}

function bkPaint(v: any): void {
  if (!v) return;
  bkView = v;
  const card = document.getElementById('bk-card');
  if (!card) return;
  const running = !!bkJob || !!v.running;
  card.classList.toggle('is-running', running);
  card.classList.toggle('is-empty', !v.lastRunAt && !running);
  card.classList.toggle('has-error', !!v.lastError && !running);
  const title = card.querySelector('.bk-card-title') as HTMLElement;
  const sub = card.querySelector('.bk-card-sub') as HTMLElement;
  if (running) {
    title.textContent = t('settingsBackups.backing_up');
    sub.textContent = (bkJob && bkJob.note) || t('settingsBackups.writing_every_project_to_the_backup');
  } else if (v.lastRunAt) {
    title.textContent = t('settingsBackups.last_backup', { lastRunAt: jpAgo(v.lastRunAt) });
    sub.textContent = v.cadence === 'off' ? t('settingsBackups.the_schedule_is_off_back_up')
      : t('settingsBackups.next_backup', { nextAt: bkWhen(v.nextAt) });
  } else {
    title.textContent = t('settingsBackups.no_backups_yet');
    sub.textContent = v.cadence === 'off' ? t('settingsBackups.the_schedule_is_off_back_up_2')
      : t('settingsBackups.the_first_one_runs_within_minutes');
  }
  const fill = card.querySelector('.bk-bar-fill') as HTMLElement;
  fill.style.width = Math.round(100 * ((bkJob && bkJob.progress) || 0)) + '%';
  (card.querySelector('.bk-card-err') as HTMLElement).textContent = running ? '' : (v.lastError || '');
  const now = document.getElementById('bk-now') as HTMLButtonElement | null;
  if (now) now.disabled = running;

  const path = document.getElementById('bk-path');
  // The LRM keeps a leading "/" in place under the path's rtl ellipsis (backup.css).
  if (path) { path.textContent = '\u200E' + v.folder; path.title = v.folder; }
  const reset = document.getElementById('bk-default');
  if (reset) reset.hidden = !v.custom;
  sfSegValue('bk-cadence', v.cadence);
  const keep = document.getElementById('bk-keep') as HTMLSelectElement | null;
  if (keep) {
    if (![...keep.options].some((o) => o.value === String(v.keep))) {
      const o = document.createElement('option');
      o.value = String(v.keep);
      o.textContent = t('settingsBackups.per_project_2', { keep: v.keep });
      keep.appendChild(o);
    }
    keep.value = String(v.keep);
  }
}

async function bkRefresh(): Promise<void> {
  try { bkPaint(await window.hubBackup.settings()); } catch (_) { /* bridge missing: section stays as built */ }
}

async function bkBackUpNow(): Promise<boolean> {
  bkJob = { progress: 0 };
  if (bkView) bkPaint(bkView);
  const r = await window.hubBackup.backUpNow();
  bkJob = null;
  await bkRefresh();
  if (!r || r.canceled) return false;
  if (!r.ok) { showToast(r.error || t('settingsBackups.the_backup_failed'), { kind: 'error' }); return false; }
  const n = r.count || 0;
  showToast(n ? t('settingsBackups.backed_up', { p0: bkPlural(n, 'project'), p1: (r.failed && r.failed.length ? t('settingsBackups.could_not_be', { failedCount: r.failed.length }) : '') })
    : t('settingsBackups.nothing_to_back_up_yet'), { kind: r.failed && r.failed.length ? 'error' : 'success' });
  return true;
}

// ── Restore from backup… ─────────────────────────────────────────────────────

function bkClosePanelAndOpen(id: string): void {
  if (typeof hideSettingsPanel === 'function') hideSettingsPanel();
  if (typeof pjSwitchTo === 'function') void pjSwitchTo(id);
}

async function bkOpenRestore(): Promise<void> {
  const overlay = sfEl('div', 'ws-modal-overlay');
  const box = sfEl('div', 'ws-modal bk-modal');
  const head = sfEl('div', 'bk-modal-head');
  const htext = sfEl('div', 'bk-modal-htext');
  htext.append(sfEl('div', 'ws-modal-title', t('settingsBackups.restore_from_backup_2')),
    sfEl('div', 'bk-modal-sub', t('settingsBackups.the_backup_comes_back_as_a')));
  const x = sfEl<HTMLButtonElement>('button', 'btn btn-sm btn-ghost bk-modal-x');
  x.type = 'button';
  iconOnly(x, 'x', t('common.close'));
  head.append(htext, x);
  const list = sfEl('div', 'bk-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('settingsBackups.backups'));
  const foot = sfEl('div', 'bk-modal-foot');
  const where = sfEl('div', 'bk-where');
  const cancel = bkBtn(t('common.cancel'), 'bk-cancel');
  const go = bkBtn(t('settingsBackups.restore_as_new_project'), 'btn-primary bk-go');
  go.disabled = true;
  const btns = sfEl('div', 'bk-foot-btns');
  btns.append(cancel, go);
  foot.append(where, btns);
  box.append(head, list, foot);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let picked = '';
  let busy = false;
  let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
  const close = (): void => {
    if (busy) return;
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (a11y) a11y.release();
  };
  // On WINDOW, capturing: it runs before the Settings panel's own Escape (on
  // document), so Esc closes this dialog and leaves Settings open under it.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (a11y) a11y.onTabKey(e);
  }
  window.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  x.addEventListener('click', close);
  cancel.addEventListener('click', close);
  a11y = makeModalAccessible(box, t('settingsBackups.restore_from_backup_2'), x);

  const paintList = async (): Promise<void> => {
    list.textContent = '';
    list.classList.add('is-loading');
    for (let i = 0; i < 3; i++) list.appendChild(sfEl('div', 'bk-skel'));
    let res: any = null;
    try { res = await window.hubBackup.list(); } catch (_) { res = null; }
    list.classList.remove('is-loading');
    list.textContent = '';
    where.textContent = res ? '\u200E' + res.folder : '';
    where.title = res ? res.folder : '';
    const items: any[] = (res && res.items) || [];
    // Nothing to pick: no dead "Restore" button, and Cancel reads as Close.
    go.hidden = !items.length;
    cancel.textContent = items.length ? t('common.cancel') : t('common.close');
    if (!items.length) { list.appendChild(bkEmpty(res, async () => { if (await bkBackUpNow()) await paintList(); })); return; }
    const groups = new Map<string, any[]>();
    for (const it of items) {
      const k = it.id.split('/')[0];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(it);
    }
    for (const [, rows] of groups) {
      const g = sfEl('div', 'bk-group');
      const gh = sfEl('div', 'bk-group-h');
      gh.append(sfEl('span', 'bk-group-name', rows[0].projectName), sfEl('span', 'bk-group-n', String(rows.length)));
      g.appendChild(gh);
      for (const it of rows) g.appendChild(bkRow(it, (id) => {
        picked = id;
        list.querySelectorAll('.bk-row').forEach((r) => {
          const on = (r as HTMLElement).dataset.id === id;
          r.classList.toggle('is-picked', on);
          r.setAttribute('aria-selected', String(on));
        });
        go.disabled = false;
      }));
      list.appendChild(g);
    }
    if (res.skipped) list.appendChild(sfEl('div', 'bk-skipped', t('settingsBackups.in_this_folder_could_not_be', { p0: bkPlural(res.skipped, 'file'), skipped: res.skipped })));
  };

  go.addEventListener('click', async () => {
    if (!picked || busy) return;
    busy = true;
    go.disabled = true;
    cancel.disabled = true;
    go.textContent = t('settingsBackups.restoring');
    const r = await window.hubBackup.restore(picked);
    busy = false;
    cancel.disabled = false;
    if (!r || r.canceled) { go.textContent = t('settingsBackups.restore_as_new_project'); go.disabled = false; return; }
    if (!r.ok) { go.textContent = t('settingsBackups.restore_as_new_project'); go.disabled = false; showToast(r.error || t('settingsBackups.the_backup_could_not_be_restored'), { kind: 'error' }); return; }
    bkDone(list, foot, r, () => { close(); bkClosePanelAndOpen(String(r.project.id)); }, close);
  });

  await paintList();
}

function bkRow(it: any, pick: (id: string) => void): HTMLElement {
  const row = sfEl<HTMLButtonElement>('button', 'bk-row');
  row.type = 'button';
  row.dataset.id = it.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', 'false');
  const ic = sfEl('span', 'bk-row-ic');
  ic.appendChild(icon(it.reason === 'scheduled' ? 'history' : 'shield', 16));
  const main = sfEl('span', 'bk-row-main');
  const top = sfEl('span', 'bk-row-top');
  top.appendChild(sfEl('span', 'bk-row-date', new Date(it.at).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })));
  if (it.reason !== 'scheduled') {
    top.appendChild(sfEl('span', 'bk-chip', it.reason === 'before-import' ? t('settingsBackups.before_an_import') : t('settingsBackups.before_a_version_restore')));
  }
  main.append(top, sfEl('span', 'bk-row-counts', bkCounts(it.counts || {})));
  const meta = sfEl('span', 'bk-row-meta');
  meta.append(sfEl('span', '', jpAgo(it.at)), sfEl('span', 'bk-row-size', bkSize(it.size)));
  row.append(ic, main, meta);
  row.addEventListener('click', () => pick(it.id));
  row.addEventListener('dblclick', () => (document.querySelector('.bk-go') as HTMLButtonElement | null)?.click());
  return row;
}

function bkEmpty(res: any, backUp: () => Promise<void>): HTMLElement {
  const box = sfEl('div', 'bk-empty');
  const art = sfEl('span', 'bk-empty-art');
  art.appendChild(icon('hard-drive', 22));
  box.append(art, sfEl('div', 'bk-empty-t', t('settingsBackups.no_backups_yet')),
    sfEl('div', 'bk-empty-d', t('settingsBackups.backups_show_up_here_once_one')));
  const b = bkBtn(t('settingsBackups.back_up_now'), 'btn-primary', 'hard-drive');
  b.addEventListener('click', () => { b.disabled = true; void backUp().finally(() => { b.disabled = false; }); });
  box.appendChild(b);
  if (res && res.skipped) box.appendChild(sfEl('div', 'bk-skipped', t('settingsBackups.in_the_folder_could_not_be', { p0: bkPlural(res.skipped, 'file') })));
  return box;
}

function bkDone(list: HTMLElement, foot: HTMLElement, r: any, open: () => void, close: () => void): void {
  list.textContent = '';
  const box = sfEl('div', 'bk-empty bk-done');
  const art = sfEl('span', 'bk-empty-art bk-done-art');
  art.appendChild(icon('circle-check', 22));
  box.append(art, sfEl('div', 'bk-empty-t', t('settingsBackups.restored_as', { name: r.project.name })),
    sfEl('div', 'bk-empty-d', t('settingsBackups.your_other_projects_were_not_touched', { p0: bkCounts(r.counts || {}) })));
  list.appendChild(box);
  foot.textContent = '';
  const btns = sfEl('div', 'bk-foot-btns');
  const later = bkBtn(t('common.close'), 'bk-cancel');
  later.addEventListener('click', close);
  const go = bkBtn(t('settingsBackups.open_project'), 'btn-primary bk-open');
  go.addEventListener('click', open);
  btns.append(later, go);
  foot.append(sfEl('div', 'bk-where'), btns);
  go.focus();
}

(function initSettingsBackups(): void {
  const host = document.getElementById('stp-backups');
  if (!host || !window.hubBackup) return;
  buildBackupsSection(host);
  void bkRefresh();
  window.hubBackup.onChanged((v) => bkPaint(v));
  // A running backup's progress comes off the Jobs snapshot — the same record
  // the popover paints.
  if (window.hubPlatform) {
    window.hubPlatform.onJobsChanged((snap) => {
      const j = ((snap && snap.active) || []).find((x: any) => x.kind === 'backup' && x.state === 'running');
      const was = !!bkJob;
      bkJob = j ? { progress: j.progress, note: j.note } : null;
      if (bkView && (j || was)) bkPaint(bkView);
    });
  }
  // Repaint whenever the General pane is shown: "2 h ago" must not be stale.
  const pane = host.closest('.settings-pane');
  if (pane) new MutationObserver(() => { if (!(pane as HTMLElement).hidden) void bkRefresh(); }).observe(pane, { attributes: true, attributeFilter: ['hidden'] });
})();
