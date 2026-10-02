// "SAVE AS TEMPLATE…" — any dashboard's ⋯ turns it into a template in the
// create-dashboard gallery's "Yours" group (r7:templates). Classic global-scope
// renderer <script>: no import/export.
//
// The dialog shows what the template will NEED: one row per column the
// dashboard reads, as a role — its kind, where it is used, the words that help
// the gallery match it on another dataset, and whether a dashboard can do
// without it. Main does the capture (src/analysis/userTemplate.ts) and does it
// AGAIN on save; this file only sends the author's edits to the roles, never a
// body.
//
// The THUMBNAIL is the dashboard itself: main's capturePage over the visible
// grid (the same `captureRegion` the map export uses), cropped from the top and
// scaled to a gallery card here.

const UT_KIND: Record<string, { label: string; icon: string }> = {
  date: { label: t('common.date'), icon: 'type-date' },
  measure: { label: t('common.measure'), icon: 'type-number' },
  dimension: { label: t('userTemplateSave.dimension'), icon: 'type-text' },
  geo: { label: t('common.place'), icon: 'map-pin' },
  id: { label: 'ID', icon: 'grid' },
};
const UT_THUMB_W = 480;
const UT_THUMB_H = 270;
/** Long enough for a freshly opened sheet's charts to have drawn. */
const UT_RENDER_WAIT_MS = 1500;

function utMk<T extends HTMLElement = HTMLElement>(tag: string, cls?: string, text?: string): T {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** The open dashboard's grid as a gallery-card PNG, or '' when it cannot be had. */
async function utCaptureThumb(): Promise<string> {
  const grid = document.getElementById('dash-grid');
  if (!grid || !grid.getClientRects().length) return '';
  const r = grid.getBoundingClientRect();
  const top = Math.max(0, r.top);
  const box = { x: Math.max(0, r.left), y: top, width: Math.min(r.width, window.innerWidth - Math.max(0, r.left)), height: Math.min(r.bottom, window.innerHeight) - top };
  if (box.width < 40 || box.height < 40) return '';
  let src: string | null = null;
  try { src = await window.hub.captureRegion(box); } catch (_) { src = null; }
  if (!src) return '';
  const img = new Image();
  const loaded = new Promise<boolean>((res) => { img.onload = () => res(true); img.onerror = () => res(false); });
  img.src = src;
  if (!(await loaded)) return '';
  // Cover-crop from the TOP: the KPI band and the first charts are what a
  // dashboard looks like; its bottom edge is wherever the window happened to end.
  const canvas = document.createElement('canvas');
  canvas.width = UT_THUMB_W;
  canvas.height = UT_THUMB_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const scale = Math.max(UT_THUMB_W / img.width, UT_THUMB_H / img.height);
  const sw = UT_THUMB_W / scale;
  const sh = UT_THUMB_H / scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.width - sw) / 2, 0, sw, sh, 0, 0, UT_THUMB_W, UT_THUMB_H);
  try { return canvas.toDataURL('image/png'); } catch (_) { return ''; }
}

/** ⋯ → Save as template…, from the open dashboard or a row of the list. */
async function utSaveAsTemplate(analysisId: string): Promise<void> {
  if (!currentProjectId || !analysisId) return;
  // The thumbnail is rendered from the dashboard, so it has to be on screen —
  // a row of the list opens it first.
  if (!dashCurrent || String(dashCurrent.id) !== analysisId) {
    await openAnalysis(analysisId);
    await new Promise((r) => setTimeout(r, UT_RENDER_WAIT_MS));
  }
  // Capture reads the record on disk: an edit still waiting on autosave goes first.
  if (dashCurrent && String(dashCurrent.id) === analysisId && dashDirty) await handleSaveDashboard();
  const [thumb, cap] = await Promise.all([
    utCaptureThumb(),
    window.hubTemplates.capture(currentProjectId, analysisId).catch(() => null),
  ]);
  if (!cap || !cap.ok) { showToast((cap && cap.error) || t('userTemplateSave.this_dashboard_could_not_be_read'), { kind: 'error' }); return; }
  utSaveDialog(analysisId, cap, thumb);
}

function utSaveDialog(analysisId: string, cap: any, thumb: string): void {
  let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
  const overlay = utMk('div', 'ws-modal-overlay');
  const box = utMk('div', 'ws-modal ut-modal');
  const close = (): void => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (a11y) a11y.release();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (a11y) a11y.onTabKey(e);
  }

  // ── Header ──
  const head = utMk('div', 'ut-head');
  const titles = utMk('div');
  titles.append(utMk('div', 'ws-modal-title', t('userTemplateSave.save_as_template')),
    utMk('p', 'ut-sub', t('userTemplateSave.becomes_a_template_you_can_build', { name: String(cap.name) })));
  const x = utMk<HTMLButtonElement>('button', 'an-wiz-x');
  x.type = 'button';
  iconOnly(x, 'x', t('common.close'));
  x.addEventListener('click', close);
  head.append(titles, x);

  // ── Thumbnail + name ──
  const top = utMk('div', 'ut-top');
  const art = utMk('div', 'ut-thumb');
  if (thumb) {
    const img = utMk<HTMLImageElement>('img', 'ut-thumb-img');
    img.src = thumb;
    img.alt = t('userTemplateSave.preview_of_the_dashboard');
    art.appendChild(img);
  } else {
    art.classList.add('is-empty');
    art.append(icon('layout-dashboard', 20), utMk('span', '', t('userTemplateSave.no_preview')));
  }
  const fields = utMk('div', 'ut-fields');
  const nameIn = utMk<HTMLInputElement>('input', 'ws-modal-input ut-name');
  nameIn.type = 'text';
  nameIn.maxLength = 120;
  nameIn.value = String(cap.name || '');
  const descIn = utMk<HTMLTextAreaElement>('textarea', 'ws-modal-input ut-desc');
  descIn.rows = 2;
  descIn.maxLength = 500;
  descIn.placeholder = t('userTemplateSave.what_is_this_dashboard_for_shown');
  const lab = (t: string, c: HTMLElement): HTMLElement => {
    const l = utMk('label', 'ut-field');
    l.append(utMk('span', 'ut-field-l', t), c);
    return l;
  };
  const stats = utMk('div', 'ut-stats');
  const stat = (n: number, one: string, many: string): void => {
    if (n) stats.appendChild(utMk('span', 'ut-stat', `${n} ${n === 1 ? one : many}`));
  };
  stat(cap.tiles, 'tile', 'tiles');
  stat(cap.charts, 'chart', 'charts');
  stat(cap.calcFields, t('userTemplateSave.calculated_field'), t('userTemplateSave.calculated_fields'));
  stat(cap.metrics, 'metric', 'metrics');
  fields.append(lab(t('common.name'), nameIn), lab(t('common.description'), descIn), stats);
  top.append(art, fields);

  // ── Roles ──
  const rolesHead = utMk('div', 'ut-roles-h');
  rolesHead.append(utMk('span', 'ut-roles-t', t('userTemplateSave.roles')),
    utMk('span', 'ut-roles-p', t('userTemplateSave.from_map_each_to_a_column', { rolesCount: cap.roles.length, p1: String(cap.datasetName || t('userTemplateSave.the_dataset')) })));
  const table = utMk('div', 'ut-roles');
  table.setAttribute('role', 'list');
  const cols = utMk('div', 'ut-role ut-role-cols');
  [t('userTemplateSave.role'), t('common.kind'), t('common.used_in'), t('userTemplateSave.match_words'), t('common.required')].forEach((c) => cols.appendChild(utMk('span', '', c)));
  table.appendChild(cols);
  const edits = (cap.roles as any[]).map((r) => ({ id: String(r.id), label: String(r.label), required: !!r.required, hints: (r.hints || []).map(String) }));
  (cap.roles as any[]).forEach((r, i) => {
    const e = edits[i];
    const row = utMk('div', 'ut-role');
    row.setAttribute('role', 'listitem');
    row.dataset.role = e.id;
    const who = utMk('div', 'ut-role-who');
    const label = utMk<HTMLInputElement>('input', 'ws-modal-input ut-role-label');
    label.type = 'text';
    label.maxLength = 80;
    label.value = e.label;
    label.setAttribute('aria-label', t('userTemplateSave.role_name_for', { column: String(r.column) }));
    label.addEventListener('input', () => { e.label = label.value; });
    who.append(label, utMk('span', 'ut-role-src', `from ${String(r.column)}`));
    const kindDef = UT_KIND[String(r.kind)] || UT_KIND.dimension;
    const kind = utMk('span', 'ut-kind ut-kind-' + String(r.kind));
    kind.append(icon(kindDef.icon, 16), utMk('span', '', kindDef.label));
    const where = (r.where || []).map(String);
    const used = utMk('span', 'ut-role-used');
    used.append(utMk('span', 'ut-role-n', `${r.uses} ${r.uses === 1 ? 'place' : 'places'}`),
      utMk('span', 'ut-role-where', where.slice(0, 3).join(', ') + (where.length > 3 ? ` +${where.length - 3}` : '')));
    used.title = where.join('\n');
    const hints = utMk<HTMLInputElement>('input', 'ws-modal-input ut-role-hints');
    hints.type = 'text';
    hints.value = e.hints.join(', ');
    hints.placeholder = t('userTemplateSave.e_g_revenue_sales');
    hints.setAttribute('aria-label', t('userTemplateSave.words_that_match', { label: e.label }));
    hints.addEventListener('input', () => { e.hints = hints.value.split(',').map((h) => h.trim()).filter(Boolean); });
    const req = utMk<HTMLLabelElement>('label', 'ut-req');
    const chk = utMk<HTMLInputElement>('input');
    chk.type = 'checkbox';
    chk.checked = e.required;
    chk.setAttribute('aria-label', t('userTemplateSave.is_required', { label: e.label }));
    const reqText = utMk('span', 'ut-req-t');
    const paintReq = (): void => {
      reqText.textContent = chk.checked ? t('common.required') : t('common.optional');
      row.classList.toggle('is-optional', !chk.checked);
    };
    chk.addEventListener('change', () => { e.required = chk.checked; paintReq(); });
    paintReq();
    req.append(chk, reqText);
    row.append(who, kind, used, hints, req);
    table.appendChild(row);
  });
  const note = utMk('p', 'ut-note');
  note.textContent = t('userTemplateSave.an_optional_role_left_unmapped_drops', { p0: (cap.skipped ? t('userTemplateSave.another_dataset_and_left_out', { skipped: cap.skipped }) : '') });
  if (!cap.roles.length) {
    table.innerHTML = '';
    table.appendChild(utMk('p', 'ut-empty', t('userTemplateSave.this_dashboard_reads_no_columns_the')));
  }

  const body = utMk('div', 'ut-body');
  body.append(top, rolesHead, table, note);
  const err = utMk('p', 'ut-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  const actions = utMk('div', 'ws-modal-actions ut-foot');
  const cancel = utMk<HTMLButtonElement>('button', 'btn', t('common.cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  const save = utMk<HTMLButtonElement>('button', 'btn btn-primary ut-save', t('userTemplateSave.save_template'));
  save.type = 'button';
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = t('common.saving');
    let res: any = null;
    try {
      res = await window.hubTemplates.save({
        projectId: currentProjectId, analysisId,
        name: nameIn.value.trim(), description: descIn.value.trim(),
        roles: edits, thumbnail: thumb,
      });
    } catch (_) { res = null; }
    if (!res || !res.ok) {
      save.disabled = false;
      save.textContent = t('userTemplateSave.save_template');
      err.textContent = (res && res.error) || t('userTemplateSave.the_template_could_not_be_saved');
      err.hidden = false;
      return;
    }
    close();
    showToast(t('userTemplateSave.saved_to_your_templates', { name: String(res.name) }), {
      kind: 'success',
      action: { label: t('userTemplateSave.use_it'), onClick: () => { void anCreateWizard(undefined, {}); } },
    });
  });
  actions.append(cancel, save);

  box.append(head, body, err, actions);
  overlay.appendChild(box);
  overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  a11y = makeModalAccessible(box, t('userTemplateSave.save_as_template'), nameIn);
  nameIn.select();
}
