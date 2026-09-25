'use strict';

// The card kinds beyond visual / metric / text / control — how each draws, what
// its title is, where its properties are edited, and how it is added. Classic
// global-scope renderer <script>; the model is renderer/hub/cardModel.ts.
//
// dashGrid's body dispatcher asks `renderAuthoringCard` first, so a kind here
// never reaches the text-card fallback that used to swallow unknown types.

/** Draw a card of one of these kinds. False: not ours. */
function renderAuthoringCard(card: any, body: HTMLElement): boolean {
  if (card.type === 'nav') { renderNavCard(card, body); return true; }
  return false;
}

/** The head title when a card has no heading of its own. */
function cardKindTitle(card: any): string {
  if (card.type === 'nav') return 'Navigation';
  return 'Text';
}

// Properties for a kind with no encoding. The Build/Format/Interactions tabs
// are a VISUAL's (and hidden for everything else), so these editors draw into
// a panel of their own beside them.
const KIND_EDITORS: Record<string, (card: any, host: HTMLElement) => void | Promise<void>> = {
  nav: renderNavProps,
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
  ['Navigation', 'arrow-right', handleAddNav],
];

function initCardKinds(): void {
  const after = document.getElementById('dash-add-control');
  if (!after || document.getElementById('dash-add-more')) return;
  const more = document.createElement('button');
  more.type = 'button';
  more.id = 'dash-add-more';
  more.className = 'btn btn-sm dash-edit-only';
  more.setAttribute('aria-haspopup', 'menu');
  more.appendChild(icon('plus'));
  const t = document.createElement('span');
  t.textContent = 'More';
  more.appendChild(t);
  more.appendChild(icon('chevron-down', 14));
  more.addEventListener('click', () => {
    openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
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
