// The live-model setup the measuring suites share (scripts/test-number-fidelity.ts, scripts/test-verifiedEval.ts):
// a helper, not a suite.
//
// The suites run on a temp userData either way — nothing here writes to the user's real profile. In LIVE mode the
// real config.json is COPIED in (not pointed at), because `executionReady()` reads the active CLI and its saved
// detection result from that file and there is no other way to reach a configured model. A copy, so a bug in a
// suite cannot corrupt the user's settings, and the seeded project lands in the temp dir where it belongs.

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

/** Copy this machine's desktop config into `tmpDir` (the suite's ORDINATE_LOCAL_DIR), when there is one. */
export function useLiveModel(tmpDir: string): void {
  const real = path.join(os.homedir(), 'Library', 'Application Support', 'Screenchart', 'config.json');
  const copy = path.join(tmpDir, 'config.json');
  if (!fs.existsSync(real)) return;
  fs.copyFileSync(real, copy);
  // ORDINATE_LIVE_CLI runs a suite against a specific local CLI instead of
  // whichever one the user happens to have active. This is not a convenience:
  // the CLIs differ enormously in how well they hold a prose-plus-action
  // contract, so "did the prompt hold?" is only a meaningful question once you
  // can say which model was asked. Written into the COPY, never the original.
  const want = process.env.ORDINATE_LIVE_CLI;
  if (want) {
    const cfg = JSON.parse(fs.readFileSync(copy, 'utf8'));
    cfg.localCli = { ...(cfg.localCli || {}), activeId: want };
    cfg.executionMode = 'local';
    fs.writeFileSync(copy, JSON.stringify(cfg, null, 2));
  }
}
