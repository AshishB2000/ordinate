<!--
  Phase 5 toolchain spike — the first Svelte component in the hub.

  It exists to PROVE the things the migration depends on, in the real app rather
  than on paper. Everything it renders is evidence:

    1. A compiled Svelte component mounts and runs inside the hub, under
       contextIsolation: true and the unmodified hub CSP.
    2. Runes reactivity works ($state / $derived), with no dev-mode runtime.
    3. Svelte -> vanilla, BOTH directions of the global boundary:
         * window.hub.*      — the preload bridge (a real property of window)
         * window.normalizeName — a classic script's IIFE-exported global
         * VIZ_LABELS        — a classic script's top-level `const`, which lives
                               in the GLOBAL LEXICAL environment and is NOT a
                               property of window. Bundled module code still
                               resolves it by bare identifier; `window.VIZ_LABELS`
                               would be undefined. That distinction is the single
                               most load-bearing fact in the coexistence model.
    4. This <style> block is compiled OUT of the JS into svelte/bundle.css by
       scripts/build-svelte.js (`css: 'external'`). Nothing is injected at
       runtime, so `style-src 'self'` is never violated and the CSP is unchanged.

  Replace this with the first real ported panel; keep the probes somewhere until
  the migration is done. In particular KEEP A `style:` DIRECTIVE (see the one on
  the marker dot below) — it is what holds the build guard honest.
-->
<script lang="ts">
  interface Props {
    /** Card title. Passed by main.ts, overridable by the mount call. */
    title?: string;
  }

  let { title = 'Svelte island' }: Props = $props();

  let ticks = $state(0);
  let projects = $state<number | null>(null);
  let lexical = $state('not probed');
  let windowGlobal = $state('not probed');
  let note = $state('');

  const parity = $derived(ticks % 2 === 0 ? 'even' : 'odd');

  /**
   * Vanilla -> Svelte. Instance exports are returned by Svelte's `mount()`, so
   * main.ts can hand this to the classic scripts on the mount handle. This is
   * the ONLY supported direction in: no global mutation, no event bus.
   */
  export function setNote(text: string): void {
    note = String(text ?? '');
  }

  /** Svelte -> main, over the same preload bridge the vanilla scripts use. */
  async function countProjects(): Promise<void> {
    try {
      const res: any = await (window as any).hub?.listProjects?.();
      const list = Array.isArray(res) ? res : (res && res.projects) || [];
      projects = Array.isArray(list) ? list.length : 0;
    } catch {
      projects = -1;
    }
  }

  /** Svelte -> vanilla globals. See the two cases in the header comment. */
  function probeGlobals(): void {
    // Case A: global LEXICAL binding. `const VIZ_LABELS = …` at the top level of
    // renderResult.js is reachable by bare name from anywhere in the realm —
    // including from inside this bundle's IIFE — but is not on `window`.
    try {
      // Declared in renderer/hub/globals.d.ts for the classic-script world; not
      // visible to this bundle's tsconfig, resolved at call time from the realm's
      // global lexical scope. `typeof` first — a bare reference to a name that
      // does not exist is a ReferenceError.
      const n = typeof VIZ_LABELS !== 'undefined' ? Object.keys(VIZ_LABELS).length : -1;
      const onWindow = (window as any).VIZ_LABELS !== undefined;
      lexical = n < 0
        ? 'VIZ_LABELS not found'
        : `VIZ_LABELS: ${n} chart types (on window: ${onWindow})`;
    } catch (err) {
      lexical = 'threw: ' + ((err as Error)?.message || String(err));
    }

    // Case B: a genuine window property, assigned by geoMatch.js's IIFE.
    const fn = (window as any).normalizeName;
    windowGlobal = typeof fn === 'function'
      ? `normalizeName("Roanoke County") -> "${fn('Roanoke County')}"`
      : 'window.normalizeName missing';
  }
</script>

<section class="island" aria-label="Svelte island (phase 5 spike)">
  <header class="island-head">
    <!-- The `style:` directive is deliberate and load-bearing for the BUILD, not
         just the UI: it is what pulls Svelte's internal `append_styles` STRING
         BUILDER (internal/shared/attributes.js) into the bundle. That function
         shares its name with the real <style> injector in
         internal/client/dom/css.js, and an earlier version of this build's CSP
         guard matched the bare name and failed on it. Keep a `style:` directive
         somewhere in this directory so that regression cannot come back
         unnoticed — see scripts/build-svelte.js STYLE_ELEMENT_RE. -->
    <span class="island-dot" style:opacity={ticks % 2 ? 1 : 0.55} aria-hidden="true"></span>
    <span class="island-title">{title}</span>
    <span class="island-ver">svelte {__SVELTE_VERSION__}</span>
  </header>

  <p class="island-note">
    Compiled component, classic-script host, unmodified CSP.
  </p>

  <div class="island-row">
    <button class="island-btn" type="button" onclick={() => (ticks += 1)}>
      Tick
    </button>
    <span class="island-val">{ticks} ({parity})</span>
  </div>

  <div class="island-row">
    <button class="island-btn" type="button" onclick={countProjects}>
      Count projects
    </button>
    <span class="island-val">
      {#if projects === null}—{:else if projects < 0}IPC failed{:else}{projects}{/if}
    </span>
  </div>

  <div class="island-row">
    <button class="island-btn" type="button" onclick={probeGlobals}>
      Probe globals
    </button>
  </div>

  <ul class="island-probe">
    <li>{lexical}</li>
    <li>{windowGlobal}</li>
  </ul>

  {#if note}
    <p class="island-in">from vanilla: {note}</p>
  {/if}
</section>

<style>
  /* Scoped by the compiler and extracted to svelte/bundle.css at build time.
     Uses the same custom properties as hub.css / theme.css, so the island
     themes with the rest of the app for free. */
  .island {
    max-width: 560px;
    margin: 0 0 18px;
    padding: 10px 11px;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 8px;
    background: var(--surface-2, rgba(127, 127, 127, 0.06));
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--text, inherit);
  }

  .island-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .island-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ff3e00; /* svelte orange — deliberate, this is a spike marker */
    flex: none;
  }

  .island-title {
    font-weight: 600;
    color: var(--text-strong, inherit);
  }

  .island-ver {
    margin-left: auto;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }

  .island-note {
    margin: 0 0 8px;
    opacity: 0.7;
  }

  .island-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
  }

  .island-btn {
    font: inherit;
    padding: 2px 8px;
    border-radius: 5px;
    border: 1px solid var(--border, #2a2a2a);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .island-btn:hover {
    background: var(--surface-3, rgba(127, 127, 127, 0.12));
  }

  .island-val {
    font-variant-numeric: tabular-nums;
    opacity: 0.85;
  }

  .island-probe {
    margin: 6px 0 0;
    padding-left: 14px;
    opacity: 0.75;
    word-break: break-word;
  }

  .island-in {
    margin: 6px 0 0;
    color: var(--accent, inherit);
  }
</style>
