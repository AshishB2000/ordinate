// Globals for the overlay renderer (single classic <script>: overlay.js).
// Declares the preload bridge exposed by preload/overlayPreload.js.

export {}; // make this a module so `declare global` works

declare global {
  interface Window {
    overlay: {
      // Receive the frozen frame: data is { dataUrl: string, ... }.
      onFrame(cb: (data: any) => void): void;
      // Commit the selection rect (CSS px) plus the chosen mode.
      commit(rect: { x: number; y: number; w: number; h: number; mode?: string }): void;
      cancel(): void;
    };
  }
}
