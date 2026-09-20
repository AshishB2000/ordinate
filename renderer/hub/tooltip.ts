/* ═══════════════════════════════════════════════════════════════════════
   tooltip — the behaviour behind `.tip`.

   The hub has ~70 `title` attributes and every one of them was a NATIVE
   tooltip: an OS-drawn box that cannot be styled, ignores the theme, sits
   wherever the platform decides, and waits about a second before it
   appears. A one-second delay is long enough that people stop expecting
   an answer and click the button to find out what it does.

   This file replaces all of them without touching a single call site. One
   delegated listener watches for a hover or a focus on anything carrying
   a `title`, waits 300ms, then STEALS the attribute into a variable and
   draws the text in the shared `.tip` element instead — removing the
   attribute is what suppresses the native box, and 300ms is comfortably
   inside the platform's own delay so the two never both appear.

   THAT IS THE WHOLE POINT OF STEALING IT. A `data-tip` attribute would be
   tidier and would mean migrating every one of those call sites, plus
   every `el.title = …` in the renderer, plus remembering the rule forever
   after. `title` is the attribute the app already writes, so the app
   already opts in everywhere.

   TWO THINGS THAT MATTER:

   1. The title is put BACK synchronously on the way out — on mouseout,
      blur, click, Escape and scroll. Anything that reads `.title` outside
      a hover (the smokes do) sees exactly what it always saw; the
      attribute is only ever missing during the moment the tip is up.

   2. The accessible name does not come from `title` here. `iconOnly()`
      sets `aria-label` AND `title`, and aria-label wins over title in the
      name computation, so an icon button that is hovered is still named.
      Every hand-written `el.title = …` in the renderer is either on a
      control with text content or paired with its own aria-label — the
      one case this would break (title as the ONLY name) does not exist in
      this codebase.

   Wrapped in an IIFE: renderer files are classic global scripts, so a
   top-level `let tip` here would collide with the next file that wants
   the name. Nothing is exported, so nothing goes in globals.d.ts.
   ═══════════════════════════════════════════════════════════════════════ */

(function tooltipController(): void {
  const DELAY = 300;
  const GAP = 8; // tip ↔ anchor, and tip ↔ viewport edge

  let tip: HTMLElement | null = null;
  let owner: Element | null = null; // whose title is stolen RIGHT NOW
  let stolen = '';
  let pending: Element | null = null; // hovered, timer running, title still on it
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Give the attribute back. Synchronous, always, before anything else. */
  function restore(): void {
    if (owner && stolen) owner.setAttribute('title', stolen);
    owner = null;
    stolen = '';
  }

  function hide(): void {
    clearTimeout(timer);
    pending = null;
    restore();
    if (tip) tip.hidden = true;
  }

  function show(el: Element): void {
    const text = el.getAttribute('title');
    if (!text) return;
    el.removeAttribute('title'); // ← suppresses the native tooltip
    owner = el;
    stolen = text;

    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.hidden = false;

    // Centred under the anchor, flipped above it when there is no room
    // below, and clamped inside the viewport either way — a tooltip on the
    // last toolbar button must not hang off the right edge. Measured after
    // the text is in, because the width depends on it. `element.style` from
    // JS, not an inline style= attribute: the hub CSP is style-src 'self'.
    const a = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.max(
      GAP,
      Math.min(a.left + a.width / 2 - t.width / 2, window.innerWidth - t.width - GAP),
    );
    const below = a.bottom + GAP;
    const top = below + t.height > window.innerHeight - GAP ? a.top - t.height - GAP : below;
    tip.style.left = Math.round(left + window.scrollX) + 'px';
    tip.style.top = Math.round(top + window.scrollY) + 'px';
  }

  function schedule(el: Element): void {
    if (el === owner || el === pending) return; // already showing / already counting
    hide();
    pending = el;
    timer = setTimeout(() => {
      if (pending !== el || !el.isConnected) return;
      pending = null;
      show(el);
    }, DELAY);
  }

  /** The titled element at or above `node`, or null. */
  function anchorFor(node: EventTarget | null): Element | null {
    const el = node as Element | null;
    return el && typeof el.closest === 'function' ? el.closest('[title]') : null;
  }

  // `mouseover`/`mouseout` rather than mouseenter/mouseleave: these bubble, so
  // ONE pair of listeners covers the whole app including elements that do not
  // exist yet. The containment checks are what make them behave like
  // enter/leave — moving the pointer between an icon and its button's padding
  // fires both events, and neither should close a tip that is already up.
  document.addEventListener('mouseover', (e: MouseEvent) => {
    const inside = owner || pending;
    if (inside && inside.contains(e.target as Node)) return;
    const el = anchorFor(e.target);
    if (el) schedule(el);
    else hide();
  });

  document.addEventListener('mouseout', (e: MouseEvent) => {
    const inside = owner || pending;
    if (inside && inside.contains(e.relatedTarget as Node)) return;
    hide();
  });

  // Keyboard parity: tabbing to a control gets the same hint as hovering it.
  document.addEventListener('focusin', (e: FocusEvent) => {
    const el = anchorFor(e.target);
    if (el) schedule(el);
    else hide();
  });
  document.addEventListener('focusout', hide);

  // Anything that means "I am done looking at this": the capture phase so a
  // handler that stops propagation cannot leave a tip stranded on screen.
  document.addEventListener('click', hide, true);
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') hide();
  }, true);
  // Also capture: the hub scrolls in panels, not on window, and a scroll event
  // from a panel does not bubble. The tip is positioned once and would
  // otherwise stay behind while its anchor moves out from under it.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();
