'use strict';

// The card kinds beyond visual / metric / text / control — how each draws, what
// its title is, where its properties are edited, and how it is added. Classic
// global-scope renderer <script>; the model is renderer/hub/cardModel.ts.
//
// dashGrid's body dispatcher asks `renderAuthoringCard` first, so a kind here
// never reaches the text-card fallback that used to swallow unknown types.

/** Draw a card of one of these kinds. False: not ours. */
function renderAuthoringCard(card: any, body: HTMLElement): boolean {
  const draw: Record<string, (c: any, b: HTMLElement) => void> = {
    nav: renderNavCard,
    text: renderMarkdownCard,
    image: renderImageCard,
    divider: renderDividerCard,
    container: renderContainerCard,
    tabs: renderTabsCard,
    stats: renderStatsCard, // statsTile.ts — a statistics result, recomputed per render
  };
  const fn = draw[card.type];
  if (!fn) return false;
  fn(card, body);
  return true;
}

/** The head title when a card has no heading of its own. */
function cardKindTitle(card: any): string {
  if (card.type === 'nav') return 'Navigation';
  if (card.type === 'image') return (card.image && card.image.alt) || 'Image';
  if (card.type === 'divider') return 'Divider';
  if (card.type === 'container' || card.type === 'tabs') return groupTitle(card);
  if (card.type === 'stats') return swTileTitle(card);
  return 'Text';
}

// Properties for a kind with no encoding. The Build/Format/Interactions tabs
// are a VISUAL's (and hidden for everything else), so these editors draw into
// a panel of their own beside them.
const KIND_EDITORS: Record<string, (card: any, host: HTMLElement) => void | Promise<void>> = {
  nav: renderNavProps,
  text: renderTextProps,
  image: renderImageProps,
  divider: renderDividerProps,
  container: renderGroupProps,
  tabs: renderGroupProps,
};

function renderKindProps(card: any): void {
  const body = document.getElementById('an-props-body');
  if (!body) return;
  let host = document.getElementById('an-kind-props');
  if (!host) {
    host = document.createElement('div');
    host.id = 'an-kind-props';
    host.className = 'an-kind-props';
    body.appendChild(host);
  }
  host.innerHTML = '';
  const editor = card ? KIND_EDITORS[card.type] : undefined;
  body.classList.toggle('has-kind-props', !!editor);
  host.hidden = !editor;
  if (editor) void editor(card, host);
}

// The editor head's add row holds four buttons; the new kinds share a fifth,
// "More", whose menu lists them.
const KIND_ADDS: Array<[string, string, () => void | Promise<void>]> = [
  ['Image', 'camera', handleAddImage],
  ['Divider', 'minus', handleAddDivider],
  ['Container', 'layout-dashboard', () => handleAddGroup('container')],
  ['Tabs', 'columns', () => handleAddGroup('tabs')],
  ['Navigation', 'arrow-right', handleAddNav],
];

/** What an export shows for a kind here: an image as its picture; layout-only kinds as nothing. */
async function exportAuthoringCard(card: any, layout: any): Promise<any> {
  if (card.type === 'image' && currentProjectId && card.image) {
    const res = await window.hubAuthoring.readProjectImage(currentProjectId, card.image.assetId, card.image.ext).catch(() => null);
    return res && res.ok ? { kind: 'image', layout, png: res.dataUrl, title: card.image.alt || '' } : null;
  }
  return ['nav', 'divider', 'container', 'tabs'].includes(card.type) ? null : undefined;
}

function initCardKinds(): void {
  const after = document.getElementById('dash-add-control');
  if (!after || document.getElementById('dash-add-more')) return;
  const more = document.createElement('button');
  more.type = 'button';
  more.id = 'dash-add-more';
  more.className = 'btn btn-sm dash-edit-only';
  more.setAttribute('aria-haspopup', 'menu');
  more.appendChild(icon('plus'));
  // "More" beside the four add buttons; "Add" once a narrow head folds them in
  // here (authoring.css, the dash-head container query).
  for (const [cls, text] of [['dash-more-wide', 'More'], ['dash-more-tight', 'Add']]) {
    const t = document.createElement('span');
    t.className = cls;
    t.textContent = text;
    more.appendChild(t);
  }
  more.appendChild(icon('chevron-down', 14));
  more.addEventListener('click', () => {
    openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
      // The add buttons the head folded away, delegated so each keeps its one handler.
      for (const id of ['dash-add-visual', 'dash-add-metric', 'dash-add-text', 'dash-add-control']) {
        const btn = document.getElementById(id);
        if (!btn || btn.offsetParent !== null) continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'chart-menu-item';
        row.appendChild(icon('plus', 14));
        row.append(btn.textContent.trim());
        row.addEventListener('click', () => { close(); btn.click(); });
        menu.appendChild(row);
      }
      KIND_ADDS.forEach(([label, ic, run]) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'chart-menu-item';
        row.appendChild(icon(ic, 14));
        row.append(label);
        row.addEventListener('click', () => { close(); void run(); });
        menu.appendChild(row);
      });
    });
  });
  after.after(more);
}

document.addEventListener('DOMContentLoaded', () => initCardKinds());
