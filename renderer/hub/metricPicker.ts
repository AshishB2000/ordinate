'use strict';

// The metric picker — ONE popover, every surface that asks for a number.
// Classic global-scope renderer <script>: no import/export.
//
// KPI add, the builder's measure chips and an alert rule each used to ask the
// same three questions (which dataset, which column, which aggregation) in
// three separate forms, which is how one project ends up with three different
// "Revenue"s. They now open this, pick a defined metric by name, and get its
// label and its format with it.
//
// It is NOT a replacement for those forms. The last row is "Custom…", which
// hands the caller back to whatever it did before — a column and an
// aggregation are still a perfectly good way to ask a question you only have
// once.
//
// The popover itself is `openMiniMenu` (chartControls.ts), the hub's existing
// one: positioning, outside-click and Escape are already solved there, and a
// second popover implementation is a second set of those bugs. Rows are
// `.chart-menu-item`, the same class its other callers use.

/** What the caller gets back. `null` means dismissed — no choice at all. */
interface MetricPick {
  kind: 'metric' | 'custom';
  /** Present only for kind 'metric' — the decorated summary from `metric:list`. */
  metric?: any;
}

interface MetricPickerOpts {
  /** Restrict to metrics on this dataset. Omitted → every metric in the project. */
  datasetId?: string;
  /** Hide the "Custom…" row, for a caller with no fallback form to open. */
  noCustom?: boolean;
  /** Live figures are resolved under these filters, so the number in the row is
   *  the number the card will show. */
  filters?: any[];
}

/** Rows past this and the popover is a list to scroll, not a menu to read —
 *  which is what the search box is for. */
const MPK_MAX_ROWS = 40;

/** The format chip's word. Short: it sits beside a name, not under it. */
function mpkFormatBadge(format: any): string {
  const kind = format && typeof format.kind === 'string' ? format.kind : 'number';
  if (kind === 'currency') return format.prefix || '$';
  if (kind === 'percent') return '%';
  if (kind === 'duration') return 'time';
  return format && format.compact ? '123' : '1.0';
}

/**
 * Fetch a project's metrics, decorated.
 *
 * Shared with metricsPage.ts rather than each fetching its own, because the
 * Metrics table and this popover disagreeing about what exists is exactly the
 * confusion a metrics layer is supposed to remove.
 */
async function mpkList(datasetId?: string): Promise<any[]> {
  if (!currentProjectId) return [];
  let res: any;
  try {
    res = await window.hub.listMetrics(currentProjectId);
  } catch (_) {
    return [];
  }
  const list = res && res.ok && Array.isArray(res.metrics) ? res.metrics : [];
  return datasetId ? list.filter((m: any) => m.datasetId === datasetId) : list;
}

/**
 * Open the picker under `anchorBtn`.
 *
 * Values are resolved one per row, AFTER the popover is on screen: the list has
 * to appear at the speed of a menu, and a figure that arrives a moment later in
 * place of its own "…" is the same pattern the metric card itself uses. Each
 * row's request is fire-and-forget — the popover may be gone by the time one
 * lands, so every write checks the row is still in the document.
 */
function openMetricPicker(anchorBtn: HTMLElement, opts: MetricPickerOpts = {}): Promise<MetricPick | null> {
  return new Promise((resolve) => {
    let picked: MetricPick | null = null;

    openMiniMenu(anchorBtn, (menu: HTMLElement, close: () => void) => {
      menu.classList.add('mpk-menu');

      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'mpk-search';
      search.placeholder = 'Search metrics';
      search.setAttribute('aria-label', 'Search metrics');
      menu.appendChild(search);

      const rows = document.createElement('div');
      rows.className = 'mpk-rows';
      menu.appendChild(rows);

      const empty = document.createElement('div');
      empty.className = 'mpk-empty';
      empty.textContent = 'Loading…';
      rows.appendChild(empty);

      const customRow = (): HTMLElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item mpk-custom';
        b.textContent = 'Custom…';
        b.addEventListener('click', () => { picked = { kind: 'custom' }; close(); });
        return b;
      };

      const makeRow = (m: any): HTMLElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item mpk-row';
        // The definition in words is MAIN's, generated once there and shown
        // here and in the table — never re-phrased locally.
        b.title = m.definitionText || '';

        const name = document.createElement('span');
        name.className = 'mpk-name';
        name.textContent = m.name;

        const badge = document.createElement('span');
        badge.className = 'mpk-badge';
        badge.textContent = mpkFormatBadge(m.format);

        const value = document.createElement('span');
        value.className = 'mpk-value tnum';
        value.textContent = '…';

        b.appendChild(name);
        b.appendChild(badge);
        b.appendChild(value);
        b.addEventListener('click', () => { picked = { kind: 'metric', metric: m }; close(); });

        // The figure, resolved by main. `display` is main's own formatting —
        // the renderer never re-formats a metric (src/analysis/metricFormat.ts).
        void (async () => {
          let r: any;
          try {
            r = await window.hub.metricValue(currentProjectId, m.id, opts.filters || []);
          } catch (_) {
            r = null;
          }
          if (!value.isConnected) return; // popover already dismissed
          value.textContent = r && r.ok !== false ? (r.display || '—') : '—';
        })();
        return b;
      };

      void (async () => {
        const all = await mpkList(opts.datasetId);
        if (!rows.isConnected) return;
        const paint = (): void => {
          const q = search.value.trim().toLowerCase();
          const shown = (q
            ? all.filter((m: any) =>
              m.name.toLowerCase().includes(q)
              || String(m.definitionText || '').toLowerCase().includes(q))
            : all
          ).slice(0, MPK_MAX_ROWS);

          rows.innerHTML = '';
          if (!shown.length) {
            const none = document.createElement('div');
            none.className = 'mpk-empty';
            none.textContent = all.length
              ? 'No metric matches that.'
              : 'No metrics in this project yet. Data → Metrics defines one.';
            rows.appendChild(none);
          } else {
            shown.forEach((m: any) => rows.appendChild(makeRow(m)));
          }
          if (!opts.noCustom) rows.appendChild(customRow());
        };
        paint();
        search.addEventListener('input', paint);
      })();

      // Focus the search box, not the first row: typing is how a list of
      // metrics gets short, and a picker that opens with a row focused answers
      // the down-arrow instead of the keyboard.
      setTimeout(() => { if (search.isConnected) search.focus(); }, 0);
    }, () => {
      // openMiniMenu calls this however the popover goes away — a pick, Escape
      // or an outside click — so it is the one place the promise can settle
      // exactly once.
      resolve(picked);
    });
  });
}
