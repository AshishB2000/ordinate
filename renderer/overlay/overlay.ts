const frame = document.getElementById('frame') as HTMLImageElement;
const dim = document.getElementById('dim')!;
const selection = document.getElementById('selection')!;
const dimsEl = document.getElementById('dims')!;
const hint = document.getElementById('hint')!;

interface SelRect { x: number; y: number; w: number; h: number; }

let startX = 0;
let startY = 0;
let dragging = false;
let committed = false;
let currentRect: SelRect | null = null;

// TODO: result-view override — let the user re-run as "Explain" or "Chart it" AFTER seeing
// the auto result. Wire these mode constants and setMode() to the result window in a later pass.
let selectedMode = 'auto';

function setModeExplain(): void { selectedMode = 'explain'; }
function setModeTable(): void   { selectedMode = 'table';   }

// Receive and paint the frozen screenshot.
window.overlay.onFrame((data) => {
  frame.src = data.dataUrl;
});

function cancel(): void {
  if (committed) return;
  committed = true;
  window.overlay.cancel();
}

function rectFrom(ax: number, ay: number, bx: number, by: number): SelRect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

function drawSelection(r: SelRect): void {
  selection.style.left = r.x + 'px';
  selection.style.top = r.y + 'px';
  selection.style.width = r.w + 'px';
  selection.style.height = r.h + 'px';
  dimsEl.textContent = Math.round(r.w) + ' × ' + Math.round(r.h);
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;

  dragging = true;
  committed = false;
  startX = e.clientX;
  startY = e.clientY;
  dim.hidden = true;
  selection.hidden = false;
  drawSelection({ x: startX, y: startY, w: 0, h: 0 });
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const r = rectFrom(startX, startY, e.clientX, e.clientY);
  currentRect = r;
  drawSelection(r);
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const r = rectFrom(startX, startY, e.clientX, e.clientY);
  currentRect = r;

  // Ignore a click without a real drag — cancel instead of committing nothing.
  if (r.w < 3 || r.h < 3) {
    cancel();
    return;
  }

  // Auto-detect mode: the model decides chart-vs-table in the result view.
  if (committed) return;
  committed = true;
  window.overlay.commit({ ...currentRect, mode: selectedMode });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
});
