// Preload for the multi-pod suites (test-anyPod, test-sharedCounters) —
// `node -r scripts/anyPodPreload.js src/server/main.js`. NOT a suite. It makes a
// real server process observable, and lets a suite switch a guard OFF for its
// negative control, without one line of test code in src/. Each switch is an
// env var; unset, the pod is the real thing.
//
//   ANYPOD_IDENTITY=1         dev auth reads the caller from x-test-user / x-test-org
//   ANYPOD_FAST_RUNNER=1      scheduled jobs poll every 200 ms
//   ANYPOD_MEMORY_COUNTERS=1  NEGATIVE CONTROL: the abuse counters stay in this process
//   ANYPOD_NONATOMIC_TAKE=1   NEGATIVE CONTROL: a token take that reads, then writes unconditionally
//   ANYPOD_SLOW_JOBS=a,b      jobs of these kinds wait ANYPOD_SLOW_MS (or until cancelled) before running
//   ANYPOD_OFFER_LOG=1        every offered download logs its bytes' sha256 (`anypod:offered`)

export {}; // module scope — sibling scripts share top-level names

const env = process.env;
const context: typeof import('../src/server/context') = require('../src/server/context');
const runner: typeof import('../src/server/jobs/runner') = require('../src/server/jobs/runner');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const fileTokens: typeof import('../src/server/fileTokens') = require('../src/server/fileTokens');
const files: typeof import('../src/server/files') = require('../src/server/files');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const crypto: typeof import('crypto') = require('crypto');
const fs: typeof import('fs') = require('fs');

const header = (v: string | string[] | undefined, dflt: string): string => (typeof v === 'string' && v ? v : dflt);

if (env.ANYPOD_IDENTITY === '1') {
  // main.ts calls `identityFor(cfg)` through the module's exports, so this wins.
  (context as { identityFor: typeof context.identityFor }).identityFor = () => (h) => ({
    user: { email: header(h['x-test-user'], 'dev@local'), role: 'admin' },
    org: { id: header(h['x-test-org'], 'default') },
  });
}

if (env.ANYPOD_FAST_RUNNER === '1') runner.setTimingForTest({ pollMs: 200, leaseMs: 5_000 });

if (env.ANYPOD_MEMORY_COUNTERS === '1') {
  const real = counters.useCounterDb;
  (counters as { useCounterDb: typeof real }).useCounterDb = () => real(null);
}

if (env.ANYPOD_NONATOMIC_TAKE === '1') {
  // Read, then write without re-checking — two takes that both read before either writes both win.
  const { Pool } = require('pg') as typeof import('pg');
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 4 });
  pool.on('error', () => undefined);
  (fileTokens as { takeRow: typeof fileTokens.takeRow }).takeRow = async (org, user, kind, hash) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SELECT set_config('ordinate.org', '${org}', true)`);
      const r = await c.query<{ storage_key: string; name: string; size: string }>(
        `SELECT storage_key, name, size FROM file_tokens WHERE token_hash = $2 AND org_id = $1 AND user_email = $3 AND kind = $4 AND used_at IS NULL AND expires_at > now()`,
        [org, hash, user, kind]);
      await c.query('COMMIT');
      if (!r.rows[0]) return null;
      const u = await pool.query<{ used_at: Date }>(`UPDATE file_tokens SET used_at = date_trunc('milliseconds', now()) WHERE token_hash = $1 RETURNING used_at`, [hash]);
      return { key: r.rows[0].storage_key, name: r.rows[0].name, size: Number(r.rows[0].size), usedAt: u.rows[0]?.used_at ?? new Date() };
    } finally {
      c.release();
    }
  };
}

const slow = new Set((env.ANYPOD_SLOW_JOBS ?? '').split(',').filter(Boolean));
if (slow.size) {
  const real = jobs.submit;
  (jobs as { submit: typeof real }).submit = (spec) => {
    if (!slow.has(spec.kind)) return real(spec);
    return real({
      ...spec,
      cancellable: true,
      run: async (ctx) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Number(env.ANYPOD_SLOW_MS ?? 4000));
          ctx.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        ctx.checkCancelled();
        return spec.run(ctx);
      },
    });
  };
}

if (env.ANYPOD_OFFER_LOG === '1') {
  const real = files.offerDownload;
  (files as { offerDownload: typeof real }).offerDownload = async (file, name, sha256) => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    process.stdout.write(JSON.stringify({ msg: 'anypod:offered', sha }) + '\n');
    return real(file, name, sha256);
  };
}
