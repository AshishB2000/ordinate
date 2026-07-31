import * as path from 'path';
import { BrowserWindow, screen, nativeTheme, Rectangle, TitleBarOverlayOptions } from 'electron';

const ROOT = path.join(__dirname, '..', '..');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// We hide the native title bar on both OSes so the app name shows only in our
// in-app header (no duplicate "Screenchart"). macOS keeps the traffic lights via
// hiddenInset; Windows keeps min/max/close via the title-bar overlay (WCO).
// These WCO colors mirror --titlebar / --text-strong in renderer/theme.css so the
// controls strip blends with our header in both themes. Windows-only; updated live
// on theme change via setHubTitleBarOverlay().
const TITLEBAR_HEIGHT = 40;
const WCO = {
  light: { color: '#fafbfc', symbolColor: '#0f1117' },
  dark:  { color: '#1d1d21', symbolColor: '#ffffff' },
};
function wcoFor(effective: string): TitleBarOverlayOptions {
  const c = WCO[effective === 'dark' ? 'dark' : 'light'];
  return { color: c.color, symbolColor: c.symbolColor, height: TITLEBAR_HEIGHT };
}

// Windows-only: repaint the window-controls-overlay to match the current theme.
// No-op (and safe) on macOS/Linux or after the window is gone.
export function setHubTitleBarOverlay(win: BrowserWindow | null | undefined, effective: string): void {
  if (!isWin || !win || win.isDestroyed()) return;
  win.setTitleBarOverlay(wcoFor(effective));
}

// Margins so the window never sits flush against the screen edges. The bottom
// gap is intentionally large: macOS's reported workArea doesn't always fully
// exclude the Dock, so we leave extra clearance to keep the footer above it.
const TOP_MARGIN = 12;
const BOTTOM_MARGIN = 40;
const SIDE_MARGIN = 12;
// Don't fill the whole work area — leave the window noticeably short of it.
const HEIGHT_FRACTION = 0.88;

// Fit a window box inside a display's WORK AREA (screen minus Dock + menu bar).
// workArea = { x, y, width, height } — its x/y already exclude the menu bar and a
// side/top Dock, so positioning against it (not the full display bounds) is what
// keeps the window clear of the Dock. Returns { x, y, width, height }, centered
// horizontally and sized so the bottom edge clears the Dock with breathing room:
// y + height <= workArea.y + workArea.height - BOTTOM_MARGIN.
function fitToWorkArea(workArea: Rectangle, preferredWidth: number): Rectangle {
  const maxW = Math.max(0, workArea.width - SIDE_MARGIN * 2);
  const maxH = Math.max(0, workArea.height - TOP_MARGIN - BOTTOM_MARGIN);
  const width  = Math.max(900, Math.min(preferredWidth, maxW));
  const height = Math.min(maxH, Math.round(workArea.height * HEIGHT_FRACTION));
  const x = workArea.x + Math.max(0, Math.round((workArea.width - width) / 2));
  const y = workArea.y + TOP_MARGIN;
  return { x, y, width, height };
}

// The hub — the app's main window: history rail + a sample capture conversation.
// Static placeholder content for now (no persistence, no AI).
export function createHubWindow(): BrowserWindow {
  // Size/position against the primary display's WORK AREA, not its full bounds,
  // so the window opens large but stays above the Dock and below the menu bar.
  const display = screen.getPrimaryDisplay();
  const preferredWidth = Math.round(display.workArea.width * 0.9);
  const { x, y, width, height } = fitToWorkArea(display.workArea, Math.min(1180, preferredWidth));

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    title: 'Screenchart',
    backgroundColor: '#f7f7f8',
    // Hide the native title bar (and its duplicate "Screenchart" text) while
    // keeping the OS window controls: traffic lights on macOS, the WCO on Windows.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(isWin ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: wcoFor(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    } : {}),
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'hubPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // If the user drags the window onto a smaller display, re-clamp so its height
  // never exceeds that display's work area (shrink-only — we never resize bigger
  // or fight a deliberate user resize). Guard against feedback loops with a flag.
  let reclamping = false;
  win.on('moved', () => {
    if (reclamping || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const b = win.getBounds();
    const maxH = Math.max(0, wa.height - TOP_MARGIN - BOTTOM_MARGIN);
    const bottomLimit = wa.y + wa.height - BOTTOM_MARGIN;
    if (b.height <= maxH && b.y >= wa.y && b.y + b.height <= bottomLimit) return;
    const height = Math.min(b.height, maxH);
    const y = Math.max(wa.y + TOP_MARGIN, Math.min(b.y, bottomLimit - height));
    reclamping = true;
    win.setBounds({ x: b.x, y, width: b.width, height });
    reclamping = false;
  });

  win.loadFile(path.join(ROOT, 'renderer', 'hub', 'index.html'));
  return win;
}
