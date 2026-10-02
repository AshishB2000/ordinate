// Round 8 — the IPC areas added together on feat/round-8, wired from ONE line
// in src/main.ts (which sits near its 800-line cap). Each area is its own
// src/ipc/*.ts with its own register(); this file only calls them.

export interface Round8Deps {
  /**
   * True in a headless run (`--cli` / `--mcp`): register handlers, but start
   * no watchers or timers — a CLI process must not run what the GUI owns.
   */
  headless?: boolean;
}

export function register(deps: Round8Deps): void {
  void deps;

  // r8:facets

  // r8:pipelines
  require('./pipelines').register(deps); // the Data page's Pipelines tab: one DAG, run, schedule, history

  // r8:events
  (require('./events') as typeof import('./events')).register();

  // r8:summary
  require('./summary').register(); // the Summary card (src/ipc/summary.ts)

  // r8:search
}
