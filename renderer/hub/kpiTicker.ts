// The KPI TICKER: a metric card's figure counts from the number it showed to
// the one main just computed, over 400 ms, eased. The math is PURE
// (`tickValueAt`, `tickFrames`), shared the markdown.ts way so
// scripts/test-motion.js checks the frames; `kpiTick` is the small DOM driver.
//
// Every in-between frame is printed by the card's OWN formatter, so a "$5.2M"
// card ticks through "$4.8M", never "4812345.67" — and the last frame is not a
// formatted float but the exact string main sent, so the figure a reader is
// left with is the computed one, character for character. The value element
// is `.dash-metric-value` (tabular figures, hub.css): the digits change, the
// box does not, so nothing beside or under it moves.
//
// Reduced motion (chartRender.ts, read live) is an instant swap.
(function (global: any) {
  const KPI_TICK_MS = 400;

  /** easeOutCubic — fast off the mark, settling into the final figure. */
  function tickEase(t: number): number {
    const u = 1 - Math.min(1, Math.max(0, t));
    return 1 - u * u * u;
  }

  /** The figure at progress t ∈ [0, 1]; exactly `to` at the end, not a float near it. */
  function tickValueAt(from: number, to: number, t: number): number {
    if (t >= 1) return to;
    if (t <= 0) return from;
    return from + (to - from) * tickEase(t);
  }

  /** Every frame of a tick: first `from`, last exactly `to`. Reduced motion is one frame. */
  function tickFrames(from: number, to: number, durationMs: number, fps: number, reduced?: boolean): number[] {
    if (reduced || !(durationMs > 0) || !(fps > 0)) return [to];
    const n = Math.max(1, Math.round((durationMs * fps) / 1000));
    const out: number[] = [];
    for (let k = 0; k <= n; k++) out.push(tickValueAt(from, to, k / n));
    return out;
  }

  // What each card last showed, by card id — the `from` of its next tick, and
  // what it shows (instead of "…") while the next figure is in flight.
  const kpiLast = new Map<string, { value: number | null; text: string }>();

  function kpiHold(key: string): string {
    const l = kpiLast.get(key);
    return l ? l.text : '';
  }

  function kpiForget(): void { kpiLast.clear(); }

  /**
   * Show `text` in `el`, ticking there from this card's previous figure. `to` is
   * main's number behind `text`; `fmt` is the card's own formatter.
   */
  function kpiTick(el: HTMLElement, key: string, to: number | null, text: string, fmt: (v: number) => string): void {
    const prev = kpiLast.get(key);
    const target = typeof to === 'number' && Number.isFinite(to) ? to : null;
    kpiLast.set(key, { value: target, text });
    const from = prev ? prev.value : null;
    const reduced = typeof chartMotionReduced === 'function' && chartMotionReduced();
    if (from === null || target === null || from === target || reduced) { el.textContent = text; return; }

    const start = performance.now();
    let written = '';
    const write = (s: string): void => { written = s; el.textContent = s; };
    const frame = (v: number): string => { try { return fmt(v); } catch (_) { return text; } };
    el.classList.add('is-ticking');
    const step = (now: number): void => {
      // Gone, or someone else wrote the figure ("Calculate as" repaints it): stop.
      if (!el.isConnected || el.textContent !== written) { el.classList.remove('is-ticking'); return; }
      const t = (now - start) / KPI_TICK_MS;
      if (t >= 1) { write(text); el.classList.remove('is-ticking'); return; }
      write(frame(tickValueAt(from, target, t)));
      requestAnimationFrame(step);
    };
    write(frame(from));
    requestAnimationFrame(step);
  }

  const api = { tickEase, tickValueAt, tickFrames, KPI_TICK_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    global.tickValueAt = tickValueAt;
    global.tickFrames = tickFrames;
    global.kpiTick = kpiTick;
    global.kpiHold = kpiHold;
    global.kpiForget = kpiForget;
  }
})(typeof window !== 'undefined' ? window : globalThis);
