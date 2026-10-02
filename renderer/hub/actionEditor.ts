'use strict';

// Properties → Interactions: the ACTIONS a visual tile runs. Classic
// global-scope renderer <script>.
//
// Every edit writes `card.actions` and goes through `markDashDirty`, so it is
// saved by the ordinary autosave (main re-sanitizes it through cardModel) and
// undone by the ordinary undo. Warnings come from `cardModel.validateActions`
// — a dashboard, page, tile or visual that no longer exists is SHOWN here,
// never silently dropped from the record.

const AE_KINDS: Array<[string, string]> = [
  ['navigate', t('actionEditor.open_a_dashboard_or_page')],
  ['url', t('actionEditor.open_a_web_link')],
  ['filter_target', t('actionEditor.narrow_chosen_tiles')],
  ['tooltip_visual', t('actionEditor.show_a_visual_in_the_tooltip')],
];
const AE_CARRY: Array<[string, string]> = [
  ['clicked_value', t('actionEditor.the_clicked_value')],
  ['all_selection', t('actionEditor.the_clicked_value_and_every_current')],
  ['none', t('actionEditor.nothing')],
];

/** Every dashboard with its pages, every visual, every visual tile on this dashboard. */
async function authoringRefs(): Promise<{ analyses: any[]; visuals: any[]; tiles: any[] }> {
  if (!currentProjectId) return { analyses: [], visuals: [], tiles: [] };
  const pid = currentProjectId;
  const [list, visuals] = await Promise.all([
    window.hub.listAnalyses(pid).catch(() => []),
    window.hub.listVisuals(pid).catch(() => []),
  ]);
  const analyses = await Promise.all((Array.isArray(list) ? list : []).map(async (s: any) => {
    const full = dashCurrent && s.id === dashCurrent.id ? dashCurrent : await window.hub.getAnalysis(pid, s.id).catch(() => null);
    const pages = full && Array.isArray(full.sheets || full.pages) ? (full.sheets || full.pages) : [];
    return { id: s.id, name: String(s.name || t('common.untitled')), pages: pages.map((p: any) => ({ id: p.id, name: p.name })) };
  }));
  const vs = Array.isArray(visuals) ? visuals : [];
  const nameOf = (id: string): string => (vs.find((v: any) => v.id === id) || {}).name || 'Visual';
  const tiles: any[] = [];
  for (const page of (dashCurrent && dashCurrent.pages) || []) {
    for (const c of page.cards || []) {
      if (c && c.type === 'visual') tiles.push({ id: c.id, title: `${nameOf(c.visualId)} · ${page.name}` });
    }
  }
  return { analyses, visuals: vs.map((v: any) => ({ id: v.id, name: v.name })), tiles };
}

function aeSelect(label: string, items: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'ae-field';
  const t = document.createElement('span');
  t.className = 'ae-label';
  t.textContent = label;
  const sel = document.createElement('select');
  sel.className = 'viz-select';
  items.forEach(([v, text]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = text;
    sel.appendChild(o);
  });
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  wrap.append(t, sel);
  return wrap;
}

function aeInput(label: string, value: string, placeholder: string, hint: string, onChange: (v: string) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'ae-field';
  const t = document.createElement('span');
  t.className = 'ae-label';
  t.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'an-prop-input';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('change', () => onChange(input.value));
  wrap.append(t, input);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'ae-hint';
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

/** The dashboard + page pickers a navigate action and a nav button share. */
function aeTargetFields(refs: any, target: any, onChange: (t: any) => void): HTMLElement[] {
  const an: Array<[string, string]> = [['', t('actionEditor.choose_a_dashboard')]].concat(
    refs.analyses.map((a: any) => [a.id, a.id === (dashCurrent && dashCurrent.id) ? t('actionEditor.this_one', { name: a.name }) : a.name]),
  ) as Array<[string, string]>;
  const chosen = refs.analyses.find((a: any) => target && a.id === target.analysisId);
  const out = [aeSelect(t('common.dashboard'), an, (target && target.analysisId) || '', (v) => onChange(v ? { analysisId: v } : undefined))];
  if (chosen && chosen.pages.length > 1) {
    const pages: Array<[string, string]> = [['', t('actionEditor.its_first_page')]].concat(chosen.pages.map((p: any) => [p.id, p.name])) as Array<[string, string]>;
    out.push(aeSelect(t('common.page'), pages, (target && target.page) || '', (v) => onChange(v ? { analysisId: chosen.id, page: v } : { analysisId: chosen.id })));
  }
  return out;
}

function aeWarnings(list: string[]): HTMLElement | null {
  if (!list.length) return null;
  const box = document.createElement('div');
  box.className = 'ae-warn';
  box.setAttribute('role', 'status');
  list.forEach((w) => {
    const p = document.createElement('p');
    p.appendChild(icon('alert', 14));
    p.append(w);
    box.appendChild(p);
  });
  return box;
}

/** Appended to the Interactions tab for a visual card (authoringProps.anRenderInteractions). */
async function renderActionEditor(card: any, host: HTMLElement): Promise<void> {
  if (!card || card.type !== 'visual') return;
  const sec = document.createElement('section');
  sec.className = 'ae-sec';
  const h = document.createElement('h4');
  h.className = 'ae-h';
  h.textContent = t('actionEditor.actions');
  const intro = document.createElement('p');
  intro.className = 'an-prop-note an-prop-note--info';
  intro.textContent = t('actionEditor.what_a_click_on_a_mark');
  const list = document.createElement('div');
  list.className = 'ae-list';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm ae-add';
  add.appendChild(icon('plus'));
  const addT = document.createElement('span');
  addT.textContent = t('actionEditor.add_action');
  add.appendChild(addT);
  sec.append(h, intro, list, add);
  host.appendChild(sec);

  const refs = await authoringRefs();
  const live = (): any => dashCardAnywhere(card.id) || card;
  const write = (next: any[], label: string): void => {
    live().actions = next;
    markDashDirty(label, true);
    paint();
    renderDashGrid();
    anPaintSelection();
  };

  const paint = (): void => {
    list.innerHTML = '';
    const actions: any[] = Array.isArray(live().actions) ? live().actions : [];
    const warnings = cardModel.validateActions(actions, {
      analyses: refs.analyses, visualIds: refs.visuals.map((v: any) => v.id), tileIds: refs.tiles.map((t: any) => t.id),
    });
    actions.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'ae-row';
      row.dataset.actionId = a.id;
      const set = (patch: any, label = t('actionEditor.edit_action')): void => {
        const next = actions.slice();
        next[i] = cardModel.sanitizeAction(Object.assign({}, a, patch));
        write(next, label);
      };
      const top = document.createElement('div');
      top.className = 'ae-row-head';
      top.appendChild(aeSelect(t('common.when'), a.kind === 'tooltip_visual' ? [['click', t('actionEditor.on_hover')]] : [['click', t('actionEditor.click_a_mark')], ['menu', t('actionEditor.from_the_card_menu')]],
        a.kind === 'tooltip_visual' ? 'click' : a.trigger, (v) => set({ trigger: v })));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-sm ae-del';
      iconOnly(del, 'trash', t('actionEditor.remove_this_action'));
      del.addEventListener('click', () => write(actions.filter((_: any, k: number) => k !== i), t('actionEditor.remove_action')));
      top.appendChild(del);
      row.appendChild(top);
      row.appendChild(aeSelect(t('actionEditor.do'), AE_KINDS, a.kind, (v) => set({ kind: v }, t('actionEditor.change_action'))));
      if (a.kind === 'navigate') {
        aeTargetFields(refs, a.target, (t) => set({ target: t })).forEach((el) => row.appendChild(el));
        row.appendChild(aeSelect(t('actionEditor.carry'), AE_CARRY, a.carry, (v) => set({ carry: v })));
      } else if (a.kind === 'url') {
        row.appendChild(aeInput(t('common.address'), a.url || '', 'https://example.com/search?q={{value}}',
          t('actionEditor.becomes_the_clicked_value_url_encoded'), (v) => set({ url: v })));
      } else if (a.kind === 'filter_target') {
        const box = document.createElement('fieldset');
        box.className = 'ae-tiles';
        const lg = document.createElement('legend');
        lg.className = 'ae-label';
        lg.textContent = t('actionEditor.narrow_these_tiles');
        box.appendChild(lg);
        const others = refs.tiles.filter((t: any) => t.id !== card.id);
        if (!others.length) {
          const p = document.createElement('p');
          p.className = 'ae-hint';
          p.textContent = t('actionEditor.add_another_visual_tile_to_narrow');
          box.appendChild(p);
        }
        others.forEach((t: any) => {
          const l = document.createElement('label');
          l.className = 'an-prop-check';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = (a.tiles || []).includes(t.id);
          cb.addEventListener('change', () => {
            const tiles = new Set<string>(a.tiles || []);
            if (cb.checked) tiles.add(t.id); else tiles.delete(t.id);
            set({ tiles: [...tiles] });
          });
          const s = document.createElement('span');
          s.textContent = t.title;
          l.append(cb, s);
          box.appendChild(l);
        });
        row.appendChild(box);
      } else if (a.kind === 'tooltip_visual') {
        const items: Array<[string, string]> = [['', t('actionEditor.choose_a_visual')]].concat(refs.visuals.map((v: any) => [v.id, v.name])) as Array<[string, string]>;
        row.appendChild(aeSelect('Visual', items, a.tooltipVisualId || '', (v) => set({ tooltipVisualId: v || undefined })));
      }
      if (a.trigger === 'menu' && a.kind !== 'tooltip_visual') {
        row.appendChild(aeInput(t('actionEditor.menu_label'), a.label || '', tileActionLabel(a), '', (v) => set({ label: v })));
      }
      const w = aeWarnings(warnings[i] || []);
      if (w) row.appendChild(w);
      list.appendChild(row);
    });
  };
  add.addEventListener('click', () => {
    const actions: any[] = Array.isArray(live().actions) ? live().actions : [];
    write(actions.concat([cardModel.sanitizeAction({ kind: 'navigate', trigger: 'click', carry: 'clicked_value' })]), t('actionEditor.add_action'));
  });
  paint();
}
