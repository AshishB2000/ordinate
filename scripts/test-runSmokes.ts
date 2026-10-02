// The smoke runner's sharding (scripts/run-smokes.ts shardOf) — every smoke in
// exactly one shard, shards balanced by recorded duration, and the recorded
// file naming only smokes that exist. A smoke dropped by the split would be a
// smoke that silently stopped running in CI.
//
//   npm run build:ts && node scripts/test-runSmokes.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
import { SMOKES, shardOf } from './run-smokes';

const durations: Record<string, number> = JSON.parse(fs.readFileSync(path.join(__dirname, 'smoke-durations.json'), 'utf8'));

const N = 4;
const shards = Array.from({ length: N }, (_, i) => shardOf(SMOKES, durations, i + 1, N));
const all = shards.flat();
ok('every smoke lands in some shard', SMOKES.every((s) => all.includes(s)), SMOKES.filter((s) => !all.includes(s)).join(','));
ok('no smoke lands in two shards', all.length === SMOKES.length && new Set(all).size === all.length, all.length);
ok('each shard keeps the chain order', shards.every((sh) => sh.every((s, i) => i === 0 || SMOKES.indexOf(sh[i - 1]) < SMOKES.indexOf(s))));

const cost = (sh: string[]) => sh.reduce((t, s) => t + (durations[s] ?? 120), 0);
const loads = shards.map(cost);
const biggest = Math.max(...SMOKES.map((s) => durations[s] ?? 120));
ok('the heaviest and lightest shard differ by less than one smoke', Math.max(...loads) - Math.min(...loads) <= biggest, loads.join(' / '));
ok('the same input gives the same split', JSON.stringify(shardOf(SMOKES, durations, 2, N)) === JSON.stringify(shards[1]));

ok('every smoke has a recorded duration', SMOKES.every((s) => typeof durations[s] === 'number'), SMOKES.filter((s) => typeof durations[s] !== 'number').join(','));
ok('the durations file names no smoke that is gone', Object.keys(durations).every((k) => SMOKES.includes(k)), Object.keys(durations).filter((k) => !SMOKES.includes(k)).join(','));
ok('every listed smoke has a source file', SMOKES.every((s) => fs.existsSync(path.join(__dirname, s + '.ts'))));

// A smoke with no recorded time still lands somewhere.
const extra = shardOf(SMOKES.concat('smoke-new'), durations, 1, 1);
ok('an unmeasured smoke is still scheduled', extra.includes('smoke-new'));

finish();
