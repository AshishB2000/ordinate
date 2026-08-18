// The data table behind a result — renders a <table>, not a chart.
//
// It shares the {labels, series} input with buildChart and colors its header
// swatches from the same CHART_PALETTE, which is why it lived in chartRender.ts;
// but it constructs no Chart.js instance, reads no chart type, and touches no
// canvas. Its whole job is DOM. renderResult.ts calls it for the table view and
// plotRender.ts falls back to it for the Mosaic types it does not draw.
//
// Loads after chartPalette.js (for CHART_PALETTE), before chartRender.js.
// Classic global-scope script — NO import/export.
//
// Cells are written with textContent / append only — never innerHTML with data
// in it — so a label containing markup renders as text rather than HTML. The one
// innerHTML is the constant '' that clears the table.

function buildDataTable(table: HTMLTableElement, data: ChartDataShape): void {
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series: ChartSeriesShape[] = Array.isArray(data.series) ? data.series : [];
  table.innerHTML = '';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const thLabel = document.createElement('th');
  thLabel.textContent = 'Label';
  headerRow.appendChild(thLabel);
  series.forEach((s: ChartSeriesShape, si: number) => {
    const th = document.createElement('th');
    const sw = document.createElement('span');
    sw.className = 'cv-swatch';
    sw.style.background = CHART_PALETTE[si % CHART_PALETTE.length];
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
