// Build depth — the IPC areas added together on feat/build-depth, wired from
// ONE line in src/main.ts (which sits near its 800-line cap). Each area is its
// own src/ipc/*.ts with its own register(); this file only calls them.

export interface BuildDeps {
  /**
   * True in a headless run (`--cli` / `--mcp`): register handlers, but start
   * no watchers or timers — a CLI process must not run what the GUI owns.
   */
  headless?: boolean;
}

export function register(deps: BuildDeps): void {
  void deps;

  // build:plan
  require('./plan').register(); // Assistant plans: check, run step by step, undo

  // build:format

  // build:theme

  // build:saas

  // build:snapshots

}
