// Loading skeletons — the ONE thing this app shows while it is fetching.
//
// Classic global-scope renderer script (NO import/export); loaded right after
// icons.js so every caller can reach it.
//
// WHY A SKELETON AND NOT A SPINNER. A spinner says "something is happening";
// a skeleton says "a table of about this shape is arriving". It also holds the
// layout, so nothing under it jumps when the rows land — the reason a dataset
// grid, a dashboard tile and a card thumbnail all get one and the spin
// keyframes that used to sit in those three places are gone (hub.css keeps
// exactly one `spin`, for the dock's send button).
//
// ACCESSIBILITY IS THE POINT OF `skelClear`. Every skeleton node is
// `aria-hidden` and its host carries `aria-busy="true"`, so a screen reader
// reads "busy" rather than a dozen fake placeholder rows. A caller that forgets
// to clear leaves the region permanently announced as busy, which is why the
// clear is a function and not an `innerHTML = ''` at each call site: the hosts
// that repaint by clearing their own innerHTML still need the attribute off.
//
// The shimmer is a plain CSS `animation` on `.sk` (see hub.css) — deliberately
// NOT a JS loop or an inline style, so the global prefers-reduced-motion block
// zeroes it along with everything else, and the hub CSP stays happy.

/** A single shimmering block. `cls` adds a sizing modifier (see hub.css). */
function skelBlock(cls?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls ? 'sk ' + cls : 'sk';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Mark a host busy and give it a fresh skeleton container to fill. */
function skelHost(host: HTMLElement): HTMLElement {
  skelClear(host);
  host.setAttribute('aria-busy', 'true');
  const wrap = document.createElement('div');
  wrap.className = 'sk-wrap';
  wrap.setAttribute('aria-hidden', 'true');
  host.appendChild(wrap);
  return wrap;
}

/**
 * A grid placeholder: one header strip and `rows` rows of `cols` cells. Sized
 * from the real column count so the skeleton is the shape of the answer, capped
 * because a 1,000-column dataset would otherwise paint 1,000 shimmering cells
 * for the ~100 ms the resident path takes.
 */
function skelTable(host: HTMLElement, rows = 10, cols = 5): void {
  const wrap = skelHost(host);
  wrap.classList.add('sk-table');
  const n = Math.max(1, Math.min(12, cols));
  for (let r = 0; r <= rows; r += 1) {
    const tr = document.createElement('div');
    tr.className = r === 0 ? 'sk-tr sk-tr--head' : 'sk-tr';
    for (let c = 0; c < n; c += 1) tr.appendChild(skelBlock('sk-cell'));
    wrap.appendChild(tr);
  }
}

/**
 * A chart placeholder: one block filling the host. Used by a dashboard tile
 * while its query is in flight and by a card thumbnail while it renders — both
 * are "a rectangle of chart is coming", which is all a skeleton can honestly
 * promise before the data decides what kind. No title bar: both hosts sit under
 * a card head that already carries the name.
 */
function skelChart(host: HTMLElement): void {
  const wrap = skelHost(host);
  wrap.classList.add('sk-chart');
  wrap.appendChild(skelBlock('sk-plot'));
}

/** Drop any skeleton in `host` and stop announcing it as busy. */
function skelClear(host: HTMLElement): void {
  if (!host) return;
  host.removeAttribute('aria-busy');
  host.querySelectorAll(':scope > .sk-wrap').forEach((el) => el.remove());
}
