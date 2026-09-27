// Platform depth — the IPC areas added together on feat/platform-depth, wired
// from ONE line in src/main.ts (which sits near its 800-line cap). Each area is
// still its own src/ipc/*.ts with its own register(); this file only calls
// them, in the order they depend on each other: jobs first, because every
// other area submits work to it.

export interface PlatformDeps {
  /** Whether a hub window is focused — a finished job notifies only when not. */
  hubFocused: () => boolean;
  /** Bring the hub forward (a notification click with nothing to reveal). */
  focusHub: () => void;
  /**
   * True in a headless run (`--cli` / `--mcp`): register handlers, but start
   * no timers — a CLI process must not run backups or schedules the GUI owns.
   */
  headless?: boolean;
}

export function register(deps: PlatformDeps): void {
  require('./jobs').register(deps);
  require('./vizSample').register(); // the builder's sampled preview (visual:preview)
  // A trashed or restored record moves files without a dataset write; the
  // answer cache (engine/queryCache) hears about it here.
  require('../app/trash').onChange((projectId: string) => require('../engine/queryCache').invalidateProject(projectId));

  // platform:publish
  require('./publish').register(deps); // publish to folder, re-publish, after-refresh schedule

  // platform:privacy
  require('./privacy').register();

  // platform:automation
  require('./automation').register(deps); // Settings → Automation, the loopback MCP server, headless jobs

  // platform:backup
  require('./backups').register(deps);
}
