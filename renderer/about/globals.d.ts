// Globals for the about renderer (single classic <script>: about.js).
// Declares the preload bridge exposed by preload/aboutPreload.js.

export {}; // make this a module so `declare global` works

declare global {
  interface Window {
    about: {
      openExternal(url: string): void;
    };
  }
}
