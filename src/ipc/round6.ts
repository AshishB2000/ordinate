// Depth round 6 — the IPC areas added together on feat/depth-round-6, wired
// from ONE line in src/main.ts (which sits near its 800-line cap). Each area is
// its own src/ipc/*.ts with its own register(); this file only calls them.

export interface Round6Deps {
  /**
   * True in a headless run (`--cli` / `--mcp`): register handlers, but start
   * no watchers or timers — a CLI process must not run what the GUI owns.
   */
  headless?: boolean;
}

export function register(deps: Round6Deps): void {
  void deps;

  // r6:layouts

  // r6:stats
  require('./stats').register(); // the statistics workbench (src/ipc/stats.ts)

  // r6:text
  (require('./text') as typeof import('./text')).register();

  // r6:geo

  // r6:input

}
