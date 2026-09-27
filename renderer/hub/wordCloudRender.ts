// The word cloud chart — `word_cloud`, drawn on the SAME canvas every chart gets
// (buildChart hands it over when chartTypeSpec says isWordCloud), so the
// builder, dashboard tiles, thumbnails and every PNG/PDF export path that calls
// buildChart draw it with no branch of their own.
//
// Shape: a category and a measure, like a bar — one word per category, sized by
// the FIRST measure (wordCloudLayout.js: a deterministic spiral, sqrt scale).
// Colour:
//   · by SENTIMENT when a second measure is present and every value of it lies
//     in −1 … 1 (a VADER score, or a terms table's `sentiment`): a diverging
//     ramp built from the theme's --error ← neutral → --ok tokens, centred on 0;
//   · otherwise by the PROJECT COLOUR MAP for the category column
//     (fmtColors.ts), so "West" is the same colour here as on every other chart,
//     falling back to the theme palette in order.
//
// buildChart's callers hold what it returns as a Chart.js instance, so this
// returns an object with the handful of members they touch — canvas, data,
// options, update, resize, destroy, toBase64Image, getElementsAtEventForMode
// (so a click drills through like a bar's) — and nothing pretends to more.
//
// Classic global-scope renderer <script>: no import/export.

/** Words drawn at most — beyond this a cloud is texture, not information. */
const WC_MAX_WORDS = 150;

interface WcTheme {
  palette: string[];
  fmt: (v: any) => string;
  textColor: string;
  titleColor: string;
  fontFamily: string;
  surfColor: string;
}

function wcNum(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** −1 … 1 → a colour on the theme's own diverging ramp (error ← neutral → ok). */
function wcSentimentRamp(canvas: HTMLCanvasElement, surface: string): string[] {
  const dark = rampIsDark(surface);
  const neg = rampOfHue(getCSSVar('--error', canvas) || '#e11d48', 4, dark);
  const pos = rampOfHue(getCSSVar('--ok', canvas) || '#059669', 4, dark);
  const mid = rampOfHue('#808080', 1, dark)[0];
  return neg.slice(1).reverse().concat([mid], pos.slice(1));
}

function buildWordCloud(canvas: HTMLCanvasElement, labels: any[], allSeries: ChartSeriesShape[], overrides: any, theme: WcTheme): any {
  // The Series menu can hide a measure: hiding the colour one leaves plain words.
  const hidden = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
  const series = allSeries.filter((_, i) => !hidden.has(i));
  const size: ChartSeriesShape = series[0] || { name: '', values: [] };
  const tone = series[1];
  const toneVals = tone ? tone.values.map(wcNum) : [];
  const bySentiment = !!tone && toneVals.some((v) => v !== null) && toneVals.every((v) => v === null || (v >= -1 && v <= 1));
  // The folded "Other" tail is not a word (wordCloudLayout.ts): weight 0, never drawn.
  const words = labels.map((l, i) => ({
    text: l == null ? '' : String(l),
    weight: wordCloudIsBucket(labels, i) ? 0 : wcNum(size.values[i]) || 0,
  }));
  // The biggest WC_MAX_WORDS, chosen by the layout's own order (weight, then word).
  const keep = new Set(words.map((w, i) => ({ w, i })).filter((x) => x.w.weight > 0)
    .sort((a, b) => b.w.weight - a.w.weight || (a.w.text < b.w.text ? -1 : a.w.text > b.w.text ? 1 : 0))
    .slice(0, WC_MAX_WORDS).map((x) => x.i));
  const input = words.map((w, i) => (keep.has(i) ? w : { text: w.text, weight: 0 }));

  // Colour per category index.
  const scope = typeof fmtScopeOf === 'function' ? fmtScopeOf(overrides) : null;
  const tokens = !bySentiment && scope && scope.category && typeof fmtTokensFor === 'function'
    ? fmtTokensFor(scope.category, labels) : null;
  const ramp = bySentiment ? wcSentimentRamp(canvas, theme.surfColor) : null;
  const colorOf = (i: number): string => {
    if (ramp) {
      const v = toneVals[i];
      return v === null ? theme.textColor : rampColor(ramp, 'diverging', v, -1, 1);
    }
    const tok = tokens && tokens[i];
    return tok && typeof fmtHex === 'function' ? fmtHex(tok, theme.palette) : theme.palette[i % theme.palette.length];
  };

  const state: any = {
    canvas,
    config: { type: 'word_cloud' },
    data: {
      labels,
      datasets: allSeries.map((s) => ({ label: s.name || '', data: s.values })),
    },
    options: { events: ['mousemove', 'mouseout', 'click'], plugins: { tooltip: { enabled: true } } },
    layout: null as WcLayout | null,
    dropped: 0,
  };

  const title = typeof overrides.title === 'string' ? overrides.title.trim() : '';
  const font = (px: number, bold: boolean) => `${bold ? 700 : 500} ${px}px ${theme.fontFamily}`;

  function draw(): void {
    // Fill the parent's CONTENT box, as Chart.js's responsive sizing does — then
    // read back what CSS actually gave the canvas (a stylesheet may pin it), so
    // the backing store is never stretched.
    const host = canvas.parentElement;
    canvas.style.display = 'block'; // an inline canvas adds a descender gap its parent would grow by
    if (host) {
      const cs = getComputedStyle(host);
      const cw = host.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const ch = host.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      if (cw > 0) canvas.style.width = cw + 'px';
      if (ch > 0) canvas.style.height = ch + 'px';
    }
    const box = canvas.getBoundingClientRect();
    const w = Math.max(80, Math.round(box.width || 600));
    const h = Math.max(60, Math.round(box.height || 320));
    const dpr = typeof overrides.devicePixelRatio === 'number' ? overrides.devicePixelRatio : (window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const top = title ? 28 : 0;
    if (title) {
      ctx.font = font(14, true);
      ctx.fillStyle = theme.titleColor;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      ctx.fillText(title, w / 2, 6, w - 16);
    }
    const areaW = w - 8;
    // A live chart keeps a 16px foot for the "did not fit" line; a thumbnail (no events) does not.
    const live = state.options.events.length > 0;
    const areaH = h - top - 8 - (live ? 16 : 0);
    // Small boxes (a card thumbnail) scale the type down with them.
    const maxSize = Math.max(12, Math.min(64, Math.round(Math.min(areaH / 3.2, areaW / 7))));
    const minSize = Math.max(7, Math.min(12, Math.round(maxSize / 4)));
    const mid = (minSize + maxSize) / 2;
    const measure = (text: string, px: number): number => {
      ctx.font = font(px, px >= mid);
      return ctx.measureText(text).width;
    };
    const layout = wordCloudLayout(input, { width: areaW, height: areaH, minSize, maxSize, measure, padding: 2 });
    state.layout = layout;
    state.offset = { x: 4, y: top + 4 };
    state.dropped = layout.dropped.length;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const p of layout.placed) {
      ctx.font = font(p.size, p.size >= mid);
      ctx.fillStyle = colorOf(p.index);
      ctx.fillText(p.text, state.offset.x + p.x + 2, state.offset.y + p.y + p.h / 2);
    }
    // The empty state, and an honest count of what the box could not hold — in
    // the chart's own muted ink. A thumbnail (no events) keeps just the words.
    ctx.font = font(12, false);
    ctx.fillStyle = theme.textColor;
    if (!layout.placed.length) {
      ctx.textAlign = 'center';
      ctx.fillText('No words to draw — every value is empty or zero', w / 2, top + areaH / 2);
    } else if (live && layout.dropped.length) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      const n = layout.dropped.length;
      ctx.fillText(n.toLocaleString() + (n === 1 ? ' smaller word did' : ' smaller words did') + ' not fit', 6, h - 4);
    }
    canvas.setAttribute('aria-label', layout.placed.length
      ? 'Word cloud: ' + layout.placed.slice(0, 8).map((p) => p.text + ' ' + theme.fmt(p.weight)).join(', ')
        + (layout.placed.length > 8 ? ', …' : '')
      : 'Word cloud: no words to draw');
  }

  function hitAt(e: MouseEvent): WcPlaced | null {
    if (!state.layout) return null;
    const r = canvas.getBoundingClientRect();
    return wordCloudHit(state.layout, e.clientX - r.left - state.offset.x, e.clientY - r.top - state.offset.y);
  }

  // A tooltip in the canvas' own wrapper, like Chart.js's, painted from app figures only.
  let tip: HTMLElement | null = null;
  const onMove = (e: MouseEvent): void => {
    if (!state.options.events.length || state.options.plugins.tooltip.enabled === false) return;
    const p = hitAt(e);
    canvas.classList.toggle('wc-hot', !!p);
    if (!p) { if (tip) tip.hidden = true; return; }
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'wc-tip';
      tip.setAttribute('role', 'tooltip');
      (canvas.parentElement || document.body).appendChild(tip);
    }
    const lines = [p.text, (size.name || 'Value') + ': ' + theme.fmt(p.weight)];
    if (tone && toneVals[p.index] !== null) lines.push((tone.name || 'Colour') + ': ' + theme.fmt(toneVals[p.index]));
    tip.textContent = '';
    lines.forEach((t, k) => {
      const line = document.createElement(k === 0 ? 'strong' : 'span');
      line.textContent = t;
      tip!.appendChild(line);
    });
    tip.hidden = false;
    // The wrapper is the tooltip's containing block; the canvas sits at its offset in it.
    tip.style.left = Math.round(canvas.offsetLeft + state.offset.x + p.x + p.w / 2) + 'px';
    tip.style.top = Math.round(canvas.offsetTop + state.offset.y + p.y - 4) + 'px';
  };
  const onOut = (): void => {
    if (tip) tip.hidden = true;
    canvas.classList.remove('wc-hot');
  };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseout', onOut);

  let raf = 0;
  const ro = typeof ResizeObserver === 'function' && canvas.parentElement
    ? new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => draw());
    })
    : null;
  if (ro && canvas.parentElement) ro.observe(canvas.parentElement);

  state.update = (): void => draw();
  state.resize = (): void => draw();
  state.render = (): void => draw();
  state.setDatasetVisibility = (): void => { /* one word per category: nothing to hide */ };
  state.isDatasetVisible = (): boolean => true;
  state.toBase64Image = (): string => canvas.toDataURL('image/png');
  state.getElementsAtEventForMode = (e: MouseEvent): any[] => {
    const p = hitAt(e);
    return p ? [{ index: p.index, datasetIndex: 0 }] : [];
  };
  state.destroy = (): void => {
    if (ro) ro.disconnect();
    cancelAnimationFrame(raf);
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('mouseout', onOut);
    if (tip) tip.remove();
  };
  draw();
  return state;
}
