// Ambient types for the bundled-island world (tsconfig.svelte.json).
//
// A `.svelte` file is not TypeScript, so `tsc` cannot resolve `import Island
// from './Island.svelte'` on its own. The real fix is `svelte-check`
// (svelte2tsx + the language server), which this phase deliberately did not
// add — see docs/phase-5/01-toolchain.md §7. Until then a component imports as
// a Svelte component with `any` props: module resolution is checked, prop types
// are not.
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, any>, Record<string, any>>;
  export default component;
}
