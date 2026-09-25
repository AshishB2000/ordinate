// The right panel History and Lineage open in. Classic global-scope renderer
// <script> — NO import/export.
//
// It is the column profile's shell (dsProfile.ts, `.ds-profile` + `.dsp-*`):
// the same surface, the same head row with a name over an uppercase kind, the
// same ✕, the same scrolling body — lifted out of the dataset grid and pinned to
// the window's right edge, so a panel about a dashboard looks like the panel
// about a column rather than like a third design.
//
// ONE panel at a time. Opening History while Lineage is showing replaces it;
// Esc, the ✕ and a section change close it, and whoever opened it gets its
// onClose (the version preview uses that to put the live record back).

interface SidePanelOpts {
  /** 'history' | 'lineage' — lets a caller ask whether ITS panel is open. */
  kind: string;
  title: string;
  /** The small uppercase line under the title: "Version history · Dashboard". */
  sub: string;
  /** A lineage graph needs room; a list of versions does not. */
  wide?: boolean;
  onClose?: () => void;
}

interface SidePanel {
  el: HTMLElement;
  body: HTMLElement;
  /** Pinned under the body, like the profile's actions. Hidden until filled. */
  foot: HTMLElement;
}

let spCurrent: { kind: string; el: HTMLElement; onClose?: () => void } | null = null;

function spIsOpen(kind?: string): boolean {
  return !!spCurrent && (!kind || spCurrent.kind === kind);
}

function spClose(): void {
  const cur = spCurrent;
  if (!cur) return;
  spCurrent = null;
  cur.el.remove();
  document.body.classList.remove('ws-side-push');
  document.removeEventListener('keydown', spOnKey, true);
  if (cur.onClose) cur.onClose();
}

/**
 * Is a layer above the page on screen — a modal, a mini menu, the palette?
 * Then Escape is ITS. Checked by rect, not by presence: some of these stay in
 * the document hidden (#ds-import-modal, the palette), and a position:fixed
 * element has no offsetParent to test.
 */
function wsLayerOpen(): boolean {
  return [...document.querySelectorAll('.ws-modal-overlay, .chart-menu, .cp-overlay, .cp-sheet-overlay, .export-backdrop')]
    .some((el) => {
      if ((el as HTMLElement).hidden) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
}

function spOnKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !spCurrent || wsLayerOpen()) return;
  e.preventDefault();
  spClose();
}

function spOpen(opts: SidePanelOpts): SidePanel {
  spClose();
  const el = document.createElement('aside');
  el.className = 'ds-profile ws-side' + (opts.wide ? ' ws-side--wide' : '');
  el.dataset.kind = opts.kind;
  el.setAttribute('role', 'complementary');
  el.setAttribute('aria-label', opts.title);

  const head = document.createElement('div');
  head.className = 'dsp-head-row ws-side-head';
  const ident = document.createElement('div');
  ident.className = 'dsp-ident';
  const name = document.createElement('h4');
  name.className = 'dsp-name ws-side-title';
  name.textContent = opts.title;
  const kind = document.createElement('span');
  kind.className = 'dsp-kind';
  kind.textContent = opts.sub;
  ident.append(name, kind);
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'dsp-x ws-side-x';
  iconOnly(x, 'x', 'Close');
  x.addEventListener('click', () => spClose());
  head.append(ident, x);

  const body = document.createElement('div');
  body.className = 'dsp-body ws-side-body';
  const foot = document.createElement('div');
  foot.className = 'dsp-actions ws-side-foot';
  foot.hidden = true;

  el.append(head, body, foot);
  document.body.appendChild(el);
  document.body.classList.toggle('ws-side-push', !opts.wide);
  spCurrent = { kind: opts.kind, el, onClose: opts.onClose };
  document.addEventListener('keydown', spOnKey, true);
  return { el, body, foot };
}

/** "2:14 PM" today, "Yesterday 2:14 PM", "Sep 3, 2:14 PM" — how a version is named. */
function spWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return time;
  if (days === 1) return 'Yesterday ' + time;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts) + ', ' + time;
}
