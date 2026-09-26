'use strict';

// TEXT CARDS AS MARKDOWN. Classic global-scope renderer <script>.
//
// The body is renderer/hub/markdown.ts's subset, built into DOM with
// createElement/textContent (never innerHTML with what the author typed).
// `{{name}}` resolves at render: a dashboard parameter of that name first
// (dashParamPayload, when parameters exist), then a saved metric — shown as
// the metric's own formatted figure under the sheet's current filters, so
// "Revenue is **{{Revenue}}**" moves with the filter bar like a KPI does.

let txtMetricCache: { pid: string; at: number; list: any[] } | null = null;

async function txtMetrics(): Promise<any[]> {
  if (!currentProjectId) return [];
  const now = Date.now();
  if (txtMetricCache && txtMetricCache.pid === currentProjectId && now - txtMetricCache.at < 5000) return txtMetricCache.list;
  const res = await window.hub.listMetrics(currentProjectId).catch(() => null);
  const list = res && res.ok && Array.isArray(res.metrics) ? res.metrics : [];
  txtMetricCache = { pid: currentProjectId, at: now, list };
  return list;
}

async function txtResolveToken(name: string, el: HTMLElement): Promise<void> {
  const payload = typeof (window as any).dashParamPayload === 'function' ? (window as any).dashParamPayload() : [];
  const param = (Array.isArray(payload) ? payload : []).find((p: any) => p && p.name === name);
  if (param) {
    el.textContent = typeof (window as any).dashParamDisplay === 'function'
      ? (window as any).dashParamDisplay(param.kind, param.value) : String(param.value ?? '—');
    el.classList.add('is-resolved');
    return;
  }
  const m = (await txtMetrics()).find((x: any) => String(x.name).toLowerCase() === name.toLowerCase());
  if (m && currentProjectId) {
    const r = await window.hub.metricValue(currentProjectId, m.id, effectiveFilters()).catch(() => null);
    el.textContent = r && r.ok && typeof r.display === 'string' ? r.display : '—';
    el.title = m.name;
    el.classList.add('is-resolved');
    return;
  }
  el.classList.add('is-missing');
  el.title = `No metric or parameter is called “${name}”`;
}

function renderMarkdownCard(card: any, body: HTMLElement): void {
  body.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'md-card';
  if (card.text) {
    box.appendChild(mdRender(mdParse(card.text), document, {
      token: (n: string, el: HTMLElement) => { void txtResolveToken(n, el); },
      // Never a navigation of the hub window: main's shell-safe open, http(s) only.
      link: (a: HTMLAnchorElement, href: string) => {
        a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); window.hub.openExternal(href); });
        a.addEventListener('auxclick', (e) => e.preventDefault());
      },
    }));
  } else {
    const p = document.createElement('p');
    p.className = 'dash-card-p md-empty';
    p.textContent = 'Empty text — write Markdown in Properties.';
    box.appendChild(p);
  }
  body.appendChild(box);
  if (card.action === 'delete-sample') body.appendChild(dashSampleDeleteBtn());
}

/** Rows a card needs to show all of its body — the "Fit to content" answer. */
function txtFitRows(el: HTMLElement): number {
  const head = el.querySelector('.dash-card-head') as HTMLElement | null;
  const body = el.querySelector('.dash-card-body') as HTMLElement | null;
  // The CONTENT's height, not the body's: a body taller than its text reports
  // its own height as scrollHeight, and Fit to content must shrink as well as grow.
  const content = body && (body.firstElementChild as HTMLElement | null);
  const cs = body ? getComputedStyle(body) : null;
  const pad = cs ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : 0;
  let contentH = 0;
  if (body) for (const k of Array.from(body.children)) contentH += (k as HTMLElement).offsetHeight;
  const needed = (head ? head.offsetHeight : 0) + (content ? contentH : 0) + pad + 2;
  return Math.max(1, Math.ceil((needed + dashGapPx()) / (dashRowPx() + dashGapPx())));
}

function txtFitToContent(cardId: string): void {
  const card = dashCardAnywhere(cardId);
  const el = document.querySelector(`#dash-grid .dash-card[data-card-id="${cardId}"]`) as HTMLElement | null;
  if (!card || !el) return;
  const rows = txtFitRows(el);
  if (rows === card.layout.h) return;
  card.layout.h = rows;
  reapplyCardStyle(card);
  authoringAfterGesture(card, 'resize', 0, 0);
  markDashDirty('Fit to content');
}

/** Properties for a text card: heading, Markdown body, Fit to content. */
function renderTextProps(card: any, host: HTMLElement): void {
  const live = (): any => dashCardAnywhere(card.id) || card;
  const heading = aeInput('Heading', live().heading || '', 'Optional', '', (v) => {
    live().heading = v.trim() || undefined;
    if (!live().heading && !live().text) live().text = ' ';
    markDashDirty('Edit text', true);
    renderDashGrid();
    anPaintSelection();
  });
  host.appendChild(heading);

  const wrap = document.createElement('label');
  wrap.className = 'ae-field';
  const t = document.createElement('span');
  t.className = 'ae-label';
  t.textContent = 'Text';
  const area = document.createElement('textarea');
  area.className = 'an-prop-input md-editor';
  area.rows = 10;
  area.spellcheck = true;
  area.value = live().text || '';
  const help = document.createElement('span');
  help.className = 'ae-hint';
  help.textContent = 'Markdown: # heading, **bold**, *italic*, - list, 1. list, `code`, [link](https://…). {{Revenue}} shows a metric; {{name}} a parameter.';
  let timer: number | null = null;
  area.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const c = live();
      c.text = area.value;
      markDashDirty('Edit text', true);
      const el = document.querySelector(`#dash-grid .dash-card[data-card-id="${c.id}"] .dash-card-body`) as HTMLElement | null;
      if (el) renderMarkdownCard(c, el);
    }, 300);
  });
  wrap.append(t, area, help);
  host.appendChild(wrap);

  const fit = document.createElement('button');
  fit.type = 'button';
  fit.className = 'btn btn-sm ae-add';
  fit.textContent = 'Fit to content';
  fit.title = 'Make the card exactly as tall as its text';
  fit.addEventListener('click', () => txtFitToContent(card.id));
  host.appendChild(fit);
}
