// The data table behind a result — renders a <table>, not a chart.
//
// It shares the {labels, series} input with buildChart and colors its header
// swatches from the same --chart-1..5 tokens, which is why it lived in chartRender.ts;
// but it constructs no Chart.js instance, reads no chart type, and touches no
// canvas. Its whole job is DOM. renderResult.ts calls it for the table view and
// plotRender.ts falls back to it for the Mosaic types it does not draw.
//
// Loads after chartPalette.js (for CHART_PALETTE + getCSSVar), before chartRender.js.
// Classic global-scope script — NO import/export.
//
// Cells are written with textContent / append only — never innerHTML with data
// in it — so a label containing markup renders as text rather than HTML. The one
// innerHTML is the constant '' that clears the table.

function buildDataTable(table: HTMLTableElement, data: ChartDataShape): void {
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series: ChartSeriesShape[] = Array.isArray(data.series) ? data.series : [];
  table.innerHTML = '';
  // Swatches must match the chart, so read the SAME --chart-1..5 buildChart reads
  // rather than the raw CHART_PALETTE hexes, which ignore the theme entirely — the
  // swatches already drift from the chart's colours today. Scoped to this table
  // because a dashboard style preset remaps those tokens on a CONTAINER class, not
  // on :root. getComputedStyle of a not-yet-attached table returns '', which is why
  // the chain falls through to the root read and only then to the hex constant.
  const palette = CHART_PALETTE.map((fallback, i) => {
    const tok = '--chart-' + (i + 1);
    return getCSSVar(tok, table) || getCSSVar(tok) || fallback;
  });
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const thLabel = document.createElement('th');
  thLabel.textContent = 'Label';
  headerRow.appendChild(thLabel);
  series.forEach((s: ChartSeriesShape, si: number) => {
    const th = document.createElement('th');
    const sw = document.createElement('span');
    sw.className = 'cv-swatch';
    sw.style.background = palette[si % palette.length];
    th.appendChild(sw);
    th.append(s.name || '');
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  labels.forEach((label: any, i: number) => {
    const row = document.createElement('tr');
    const tdLabel = document.createElement('td');
    tdLabel.textContent = label;
    row.appendChild(tdLabel);
    series.forEach((s: ChartSeriesShape) => {
      const td = document.createElement('td');
      td.textContent = (s.values && s.values[i] != null) ? s.values[i] : '';
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
}
