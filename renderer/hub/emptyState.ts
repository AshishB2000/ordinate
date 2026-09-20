// THE empty state. One component, six surfaces.
//
// Split out of homePage.ts, which owned the only designed one in the app while
// Data, Visuals, Dashboards, Insights, the dock and search each hand-rolled
// their own — a bordered card here, a grey sentence there, a bare <p> in the
// dock. Classic global-scope renderer script (NO import/export); loaded right
// after icons.js, because `icon()` is its only dependency and every caller
// loads later.
//
// The DOM it builds is the `.ws-empty` family the static empty states in
// index.html already carry, deliberately: promoting the helper means one
// definition in CSS as well as one in JS, so a surface that spells its empty
// state in markup and a surface that builds it from data cannot drift apart.
// smoke-shell.ts asserts exactly that ("reuses the shared .ws-empty surface").
//
// Shape: an icon in a 48px circle, a --t-15 title, a --t-13 --muted line, and
// at most two actions — one primary, one ghost. `variant` only ever adjusts
// density (a dropdown and a full page cannot carry the same padding); it never
// restyles the parts.
//
// Actions are wired as real listeners, not markup: the hub CSP forbids inline
// handlers just as it forbids inline style.

function emptyStateBtn(cls: string, label: string, run: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = label;
  btn.addEventListener('click', run);
  return btn;
}

function makeEmptyState(opts: {
  variant: string;
  iconName: string;
  title: string;
  line: string;
  actionLabel?: string;
  onAction?: () => void;
  ghostLabel?: string;
  onGhost?: () => void;
}): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ws-empty ws-empty--' + opts.variant;

  const art = document.createElement('span');
  art.className = 'ws-empty-icon';
  art.setAttribute('aria-hidden', 'true');
  art.appendChild(icon(opts.iconName, 20));

  const title = document.createElement('h3');
  title.className = 'ws-empty-h';
  title.textContent = opts.title;

  const line = document.createElement('p');
  line.className = 'ws-empty-p';
  line.textContent = opts.line;

  box.append(art, title, line);

  const primary = opts.actionLabel && opts.onAction;
  const ghost = opts.ghostLabel && opts.onGhost;
  if (primary || ghost) {
    const actions = document.createElement('div');
    actions.className = 'ws-empty-actions';
    if (primary) actions.appendChild(emptyStateBtn('btn btn-primary', opts.actionLabel!, opts.onAction!));
    if (ghost) actions.appendChild(emptyStateBtn('btn btn-ghost', opts.ghostLabel!, opts.onGhost!));
    box.appendChild(actions);
  }
  return box;
}
