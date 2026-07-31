/*
 * Custom controlled dropdown — a trigger + a <body>-mounted, fixed-position,
 * bounded & scrollable listbox. Replaces the native <select> for the model
 * pickers: a native <select> popup is OS-rendered and CANNOT be height-capped,
 * scrolled, or repositioned with CSS (base-select / ::picker did not work in this
 * Electron build), so a long list (Cursor ~130 models, OpenCode) runs off-window.
 *
 * The list mounts in <body> at position:fixed so no ancestor's overflow can clip
 * it; JS caps its height to the available space (≤ min(320px, 55vh)) with
 * overflow-y:auto so long lists scroll INSIDE, and flips it above the trigger
 * when there's more room there. Keyboard accessible (↑/↓, Home/End, Enter, Esc).
 *
 * The trigger is a div[role=button] (not a <button>) so it can live inside the
 * settings CLI row, which is itself a <button> (nested buttons are invalid).
 *
 *   const dd = makeDropdown({ className, listClassName, ariaLabel, placeholder, onChange });
 *   dd.el                        // root element to insert into the DOM
 *   dd.setOptions(items, value)  // items: [{ value, label }]; value: selected value
 *   dd.value      (get/set)      // current value (set = programmatic, no onChange)
 *   dd.disabled   (set)          // dd.hidden (set)   dd.placeholder (set)
 *   dd.close()
 * onChange(value) fires only on a user selection that changes the value; a native
 * 'change' Event is also dispatched on dd.el. The widget is stored on dd.el._dd.
 */
(function () {
  // Local structural twins of the DropdownOpts/DropdownApi shapes in
  // globals.d.ts (those are module-scoped there, so not nameable from here).
  interface DdItem { value: string; label: string }
  interface DdOpts {
    className?: string;
    listClassName?: string;
    ariaLabel?: string;
    placeholder?: string;
    onChange?: (value: string) => void;
  }
  interface DdApi {
    el: HTMLElement;
    setOptions(items: Array<{ value: any; label?: any }> | null | undefined, value?: any): DdApi;
    getValue(): string;
    open(): void;
    close(): void;
    value: any; // string in practice; setter coerces null/undefined to ''
    disabled: boolean;
    hidden: boolean;
    placeholder: string;
  }

  let openDd: DdApi | null = null; // at most one open at a time

  function makeDropdown(opts?: DdOpts): DdApi {
    opts = opts || {};
    const root = document.createElement('div');
    root.className = 'dd' + (opts.className ? ' ' + opts.className : '');

    const trigger = document.createElement('div');
    trigger.className = 'dd-trigger';
    trigger.setAttribute('role', 'button');
    trigger.tabIndex = 0;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (opts.ariaLabel) trigger.setAttribute('aria-label', opts.ariaLabel);
    const labelEl = document.createElement('span');
    labelEl.className = 'dd-label';
    const chevron = document.createElement('span');
    chevron.className = 'dd-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    trigger.appendChild(labelEl);
    trigger.appendChild(chevron);
    root.appendChild(trigger);

    const list = document.createElement('div');
    list.className = 'dd-list' + (opts.listClassName ? ' ' + opts.listClassName : '');
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    let items: DdItem[] = [];
    let value = '';
    let disabled = false;
    let placeholder = opts.placeholder || '';
    let activeIndex = -1;

    function selectedLabel() {
      const it = items.find((i) => i.value === value);
      return it ? it.label : (placeholder || '');
    }
    function renderTrigger() {
      labelEl.textContent = selectedLabel();
      labelEl.classList.toggle('dd-placeholder', !items.some((i) => i.value === value));
    }
    function buildList() {
      list.innerHTML = '';
      items.forEach((it, i) => {
        const o = document.createElement('div');
        o.className = 'dd-opt';
        o.setAttribute('role', 'option');
        o.dataset.index = String(i);
        o.textContent = it.label;
        if (it.value === value) { o.classList.add('dd-selected'); o.setAttribute('aria-selected', 'true'); }
        o.addEventListener('click', () => selectIndex(i));
        o.addEventListener('mousemove', () => { if (activeIndex !== i) { activeIndex = i; markActive(); } });
        list.appendChild(o);
      });
    }
    function markActive() {
      Array.prototype.forEach.call(list.children, (o, i) => o.classList.toggle('dd-active', i === activeIndex));
    }
    function scrollActiveIntoView() {
      const el = list.children[activeIndex];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function position() {
      const r = trigger.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const margin = 8;
      if (r.bottom < 0 || r.top > vh) { close(); return; } // trigger scrolled out of view
      const spaceBelow = vh - r.bottom;
      const spaceAbove = r.top;
      const placeBelow = spaceBelow >= spaceAbove;
      let maxH = Math.min(320, vh * 0.55);
      maxH = Math.max(120, Math.min(maxH, (placeBelow ? spaceBelow : spaceAbove) - margin));
      list.style.position = 'fixed';
      list.style.minWidth = r.width + 'px';
      const left = Math.min(r.left, vw - margin - Math.max(r.width, 180));
      list.style.left = Math.max(margin, left) + 'px';
      list.style.maxHeight = maxH + 'px';
      if (placeBelow) { list.style.top = (r.bottom + 4) + 'px'; list.style.bottom = 'auto'; }
      else { list.style.bottom = (vh - r.top + 4) + 'px'; list.style.top = 'auto'; }
    }
    function onDocDown(e: MouseEvent) {
      const t = e.target as Node;
      if (list.contains(t) || root.contains(t)) return;
      close();
    }
    function onWinChange(e: Event) {
      if (e && e.target === list) return; // ignore the list's own internal scroll
      position();
    }
    function onKey(e: KeyboardEvent) {
      if (list.hidden) return;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); activeIndex = Math.min(items.length - 1, activeIndex + 1); markActive(); scrollActiveIntoView(); break;
        case 'ArrowUp': e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); markActive(); scrollActiveIntoView(); break;
        case 'Home': e.preventDefault(); activeIndex = 0; markActive(); scrollActiveIntoView(); break;
        case 'End': e.preventDefault(); activeIndex = items.length - 1; markActive(); scrollActiveIntoView(); break;
        case 'Enter': e.preventDefault(); selectIndex(activeIndex); break;
        case 'Escape': e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); break;
        case 'Tab': close(); break;
        default: break;
      }
    }
    function open() {
      if (disabled || !items.length || !list.hidden) return;
      if (openDd && openDd !== api) openDd.close();
      document.body.appendChild(list);
      list.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      root.classList.add('dd-open');
      activeIndex = Math.max(0, items.findIndex((i) => i.value === value));
      buildList();
      position();
      markActive();
      scrollActiveIntoView();
      openDd = api;
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onWinChange, true);
      window.addEventListener('scroll', onWinChange, true);
    }
    function close() {
      if (list.hidden) return;
      list.hidden = true;
      if (list.parentNode) list.parentNode.removeChild(list);
      trigger.setAttribute('aria-expanded', 'false');
      root.classList.remove('dd-open');
      if (openDd === api) openDd = null;
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onWinChange, true);
      window.removeEventListener('scroll', onWinChange, true);
    }
    function selectIndex(i: number) {
      if (i < 0 || i >= items.length) { close(); return; }
      const nv = items[i].value;
      const changed = nv !== value;
      value = nv;
      buildList();
      renderTrigger();
      close();
      trigger.focus();
      if (changed) {
        if (typeof opts!.onChange === 'function') opts!.onChange(value);
        root.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    trigger.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (disabled) return;
      if (list.hidden) open(); else close();
    });
    trigger.addEventListener('keydown', (e) => {
      if (!list.hidden || disabled) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    // value/disabled/hidden/placeholder are added just below via defineProperty.
    const api = {
      el: root,
      setOptions(newItems: Array<{ value: any; label?: any }> | null | undefined, newValue?: any) {
        items = (newItems || []).map((i) => ({
          value: i.value == null ? '' : String(i.value),
          label: i.label != null ? i.label : String(i.value),
        }));
        if (newValue !== undefined) value = newValue == null ? '' : String(newValue);
        buildList();
        renderTrigger();
        if (!list.hidden) position();
        return api;
      },
      getValue() { return value; },
      open: open,
      close: close,
    } as unknown as DdApi;
    Object.defineProperty(api, 'value', {
      get() { return value; },
      set(v: any) { value = v == null ? '' : String(v); buildList(); renderTrigger(); },
    });
    Object.defineProperty(api, 'disabled', {
      get() { return disabled; },
      set(v: any) { disabled = !!v; trigger.setAttribute('aria-disabled', String(disabled)); trigger.tabIndex = disabled ? -1 : 0; root.classList.toggle('dd-disabled', disabled); if (disabled) close(); },
    });
    Object.defineProperty(api, 'hidden', {
      get() { return root.hidden; },
      set(v: any) { root.hidden = !!v; if (v) close(); },
    });
    Object.defineProperty(api, 'placeholder', {
      get() { return placeholder; },
      set(v: any) { placeholder = v || ''; renderTrigger(); },
    });
    root._dd = api;
    renderTrigger();
    return api;
  }

  window.makeDropdown = makeDropdown;
})();
