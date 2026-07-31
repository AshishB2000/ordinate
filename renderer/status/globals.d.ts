// Globals for the status renderer (single classic <script>: status.js).
// Declares the preload bridge exposed by preload/statusPreload.js.
// NB: the namespace is 'screenchart', not 'status' — window.status is a
// reserved legacy DOM string property.

export {}; // make this a module so `declare global` works

declare global {
  interface Window {
    screenchart: {
      // Receive the display state: { hotkey: string, note?: string }.
      onState(cb: (data: { hotkey: string; note?: string }) => void): void;
      openHub(): void;
    };
  }
}
