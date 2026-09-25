// One registration point for the authoring-depth channels, so main.ts (at its
// 800-line cap) carries a single line for all of them.

export function register(): void {
  require('./relationships').register();
  require('./projectAssets').register();
}
