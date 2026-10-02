// Round 7 — the IPC areas added together on feat/round-7, wired from ONE line in
// src/main.ts. Each area is its own src/ipc/*.ts with its own register().

export interface Round7Deps {
  /** True in a headless run (`--cli` / `--mcp`): register handlers, start no watchers. */
  headless?: boolean;
}

export function register(deps: Round7Deps): void {
  void deps;
  // r7:notebooks
  require('./notebooks').register();
  // r7:lod
  // r7:templates
  // r7:motion
  // r7:i18n
}
