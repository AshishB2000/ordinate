'use strict';

// The NAVIGATION card: a row of buttons (or tabs) that open dashboards and
// pages, each with an icon, a label and an optional carried filter — plus a
// "Back to overview" variant. Classic global-scope renderer <script>.

function navCurrent(it: any): boolean {
  if (!it.target || !dashCurrent || it.target.analysisId !== dashCurrent.id) return false;
  const page = dashCurrentPage();
  return it.target.page ? !!page && page.id === it.target.page : dashPageIdx === 0;
}

function navRun(card: any, it: any): void {
  if (card.nav && card.nav.style === 'back' && dashCrumb) { dashNavBack(); return; }
  if (!it.target) { showToast(t('navCard.this_button_has_no_dashboard_to'), { kind: 'info' }); return; }
  const carry = it.carry ? [{ type: 'filter', column: it.carry.column, op: '=', value: it.carry.value }] : [];
  void dashNavigate(it.target, carry);
}

function renderNavCard(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  const nav = card.nav || { style: 'buttons', items: [] };
  const box = document.createElement('nav');
  box.className = 'nav-card nav-card--' + nav.style;
  box.setAttribute('aria-label', card.heading || t('navCard.dashboard_navigation'));
  const items: any[] = nav.style === 'back'
    ? [nav.items[0] || { label: t('navCard.back_to_overview') }]
    : nav.items;
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'dash-card-p';
    p.textContent = t('navCard.no_buttons_yet_add_them_in');
    box.appendChild(p);
  }
  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = nav.style === 'tabs' ? 'nav-card-tab' : 'btn btn-sm nav-card-btn';
    const ic = nav.style === 'back' ? 'arrow-left' : it.icon;
    if (ic) b.appendChild(icon(ic, 14));
    const tv = document.createElement('span');
    tv.textContent = nav.style === 'back' && dashCrumb && !it.target ? t('common.back_to', { fromName: dashCrumb.fromName }) : it.label || t('common.open');
    b.appendChild(tv);
    if (navCurrent(it)) {
      b.setAttribute('aria-current', 'page');
      b.classList.add('is-current');
    }
    if (it.carry) b.title = t('navCard.opens_with', { column: it.carry.column, value: it.carry.value });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      navRun(card, it);
    });
    box.appendChild(b);
  });
  body.appendChild(box);
}

async function handleAddNav(): Promise<void> {
  if (!dashCurrent) return;
  const refs = await authoringRefs();
  const others = refs.analyses.filter((a: any) => a.id !== dashCurrent.id).slice(0, 4);
  const items = others.length
    ? others.map((a: any) => ({ label: a.name, icon: 'layout-dashboard', target: { analysisId: a.id } }))
    : (dashCurrent.pages || []).map((p: any) => ({ label: p.name, target: { analysisId: dashCurrent.id, page: p.id } }));
  const card: any = {
    id: dashUuid(), type: 'nav',
    layout: { ...dashFindSlot(dashCards(), 12, 1), w: 12, h: 1 },
    nav: cardModel.sanitizeNav({ style: 'buttons', items }),
  };
  pushCard(card);
  void anSelectCard(card.id);
}

/** Properties for a Navigation card (cardKinds.renderKindProps). */
async function renderNavProps(card: any, host: HTMLElement): Promise<void> {
  const refs = await authoringRefs();
  const live = (): any => dashCardAnywhere(card.id) || card;
  const write = (nav: any, label: string): void => {
    live().nav = cardModel.sanitizeNav(nav);
    markDashDirty(label, true);
    renderDashGrid();
    anPaintSelection();
    paint();
  };
  const paint = (): void => {
    host.innerHTML = '';
    const nav = live().nav || { style: 'buttons', items: [] };
    const warnings = cardModel.validateNav(nav, { analyses: refs.analyses });
    host.appendChild(aeSelect(t('common.style_2'), [['buttons', t('navCard.buttons')], ['tabs', t('common.tabs')], ['back', t('navCard.back_to_overview')]], nav.style,
      (v) => write(Object.assign({}, nav, { style: v }), t('navCard.change_navigation_style'))));
    const items: any[] = nav.style === 'back' ? nav.items.slice(0, 1) : nav.items;
    if (nav.style === 'back') {
      const p = document.createElement('p');
      p.className = 'an-prop-note an-prop-note--info';
      p.textContent = t('navCard.goes_back_to_the_dashboard_a');
      host.appendChild(p);
    }
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'ae-row';
      const set = (patch: any): void => {
        const next = nav.items.slice();
        next[i] = Object.assign({}, it, patch);
        write(Object.assign({}, nav, { items: next }), t('navCard.edit_navigation'));
      };
      const head = document.createElement('div');
      head.className = 'ae-row-head';
      const title = document.createElement('span');
      title.className = 'ae-label';
      title.textContent = nav.style === 'back' ? t('navCard.overview') : t('navCard.button', { p0: i + 1 });
      head.appendChild(title);
      if (nav.style !== 'back') {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-sm ae-del';
        iconOnly(del, 'trash', t('navCard.remove_button', { p0: i + 1 }));
        del.addEventListener('click', () => write(Object.assign({}, nav, { items: nav.items.filter((_: any, k: number) => k !== i) }), t('navCard.remove_button_2')));
        head.appendChild(del);
      }
      row.appendChild(head);
      row.appendChild(aeInput(t('common.label'), it.label || '', t('common.open'), '', (v) => set({ label: v })));
      if (nav.style !== 'back') {
        const icons: Array<[string, string]> = [['', t('navCard.no_icon')]].concat(cardModel.NAV_ICONS.map((n: string) => [n, n.replace(/-/g, ' ')])) as Array<[string, string]>;
        row.appendChild(aeSelect(t('navCard.icon'), icons, it.icon || '', (v) => set({ icon: v || undefined })));
      }
      aeTargetFields(refs, it.target, (t) => set({ target: t })).forEach((el) => row.appendChild(el));
      if (nav.style !== 'back') {
        row.appendChild(aeInput(t('navCard.carry_filter'), it.carry ? `${it.carry.column} = ${it.carry.value}` : '', t('navCard.region_west'),
          t('navCard.optional_opens_the_dashboard_with_this'), (v) => {
            const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(v);
            set({ carry: m ? { column: m[1], value: m[2] } : undefined });
          }));
      }
      const w = aeWarnings(warnings[i] || []);
      if (w) row.appendChild(w);
      host.appendChild(row);
    });
    if (nav.style !== 'back' && nav.items.length < 12) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn btn-sm ae-add';
      add.appendChild(icon('plus'));
      const tv = document.createElement('span');
      tv.textContent = t('navCard.add_button');
      add.appendChild(tv);
      add.addEventListener('click', () => write(Object.assign({}, nav, { items: nav.items.concat([{ label: t('common.open') }]) }), t('navCard.add_button')));
      host.appendChild(add);
    }
  };
  paint();
}
