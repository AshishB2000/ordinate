// Globals for the permission renderer (single classic <script>: permission.js).
// Declares the preload bridge exposed by preload/permissionPreload.js.

export {}; // make this a module so `declare global` works

declare global {
  interface Window {
    permission: {
      openSettings(): Promise<any>;
      done(): void;
    };
  }
}
