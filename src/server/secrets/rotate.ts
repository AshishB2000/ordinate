// Master-key rotation (T5.3). Re-wraps every org's data key from the OLD
// master key to the NEW one in one transaction. Secret payloads are untouched:
// they are encrypted under the data keys, which do not change.
//
//   DATABASE_URL=… \
//   ORDINATE_MASTER_KEY_OLD=<current key> ORDINATE_MASTER_KEY_NEW=<new key> \
//   node src/server/secrets/rotate.js            (or: npm run secrets:rotate)
//
// Operator procedure:
//   1. Generate the new key: `openssl rand -base64 32`.
//   2. Run this command. It prints one line: how many data keys it re-wrapped.
//   3. Roll every pod with ORDINATE_MASTER_KEY=<new key>. Between steps 2 and 3
//      a pod still on the old key cannot read secrets (its error names both key
//      fingerprints); it does not corrupt anything.
//   4. Run this command again with the same OLD/NEW: it re-wraps any data key an
//      old pod created during the rollout, and prints 0 when there is none.
//   5. Destroy the old key. From here it decrypts nothing.
//
// Idempotent: rows already under NEW are counted, not touched. A row under a
// master key that is neither OLD nor NEW aborts the whole run with nothing
// changed. ponytail: a pod accepts exactly one master key, hence the read gap
// in step 3; accepting a list (new first, old for reads) closes it if needed.

import type { KeyObject } from 'crypto';
import type { Pool } from 'pg';
import { createPool, scrubbed } from '../db/pool';
import { EnvError, parseMasterKey } from '../env';
import { type DataKeyRow, SecretError, dataKeyAad, kidOf, open, seal } from './store';

export interface RotateResult {
  readonly from: string;
  readonly to: string;
  /** Data keys re-wrapped by this run. */
  readonly rewrapped: number;
  /** Data keys that were already under the new key. */
  readonly already: number;
  readonly ms: number;
}

export async function rotate(pool: Pool, oldKey: KeyObject, newKey: KeyObject): Promise<RotateResult> {
  const t0 = performance.now();
  const from = kidOf(oldKey);
  const to = kidOf(newKey);
  if (from === to) throw new SecretError('the old and new master keys are the same key');
  const client = await pool.connect();
  let rewrapped = 0;
  let already = 0;
  try {
    await client.query('BEGIN');
    // FOR UPDATE: a concurrent rotation waits, then finds every row done.
    const rows = (await client.query<DataKeyRow>('SELECT id, org_id, master_kid, wrapped, iv, tag FROM secret_data_keys ORDER BY id FOR UPDATE')).rows;
    for (const r of rows) {
      if (r.master_kid === to) {
        already++;
        continue;
      }
      if (r.master_kid !== from) {
        throw new SecretError(`a data key is wrapped by master key ${r.master_kid}, which is neither the old key (${from}) nor the new one (${to}); nothing was changed`);
      }
      const aad = dataKeyAad(r.org_id, r.id);
      let raw: Buffer;
      try {
        raw = open(oldKey, { iv: r.iv, ct: r.wrapped, tag: r.tag }, aad);
      } catch {
        throw new SecretError('a data key could not be unwrapped with the old master key (tampered row?); nothing was changed');
      }
      const w = seal(newKey, raw, aad);
      raw.fill(0);
      await client.query('UPDATE secret_data_keys SET master_kid = $2, wrapped = $3, iv = $4, tag = $5, rotated_at = now() WHERE id = $1', [r.id, to, w.ct, w.iv, w.tag]);
      rewrapped++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { from, to, rewrapped, already, ms: performance.now() - t0 };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (url === '') throw new EnvError('DATABASE_URL is required');
  const need = (name: string): KeyObject => {
    const v = process.env[name] ?? '';
    if (v === '') throw new EnvError(`${name} is required`);
    return parseMasterKey(name, v);
  };
  const oldKey = need('ORDINATE_MASTER_KEY_OLD');
  const newKey = need('ORDINATE_MASTER_KEY_NEW');
  const pool = createPool(url, () => undefined);
  try {
    const r = await rotate(pool, oldKey, newKey).catch((err: unknown) => {
      throw err instanceof SecretError ? err : scrubbed(err, url);
    });
    process.stdout.write(`ordinate: re-wrapped ${r.rewrapped} data key(s) from master key ${r.from} to ${r.to} (${r.already} already on the new key) in ${Math.round(r.ms)} ms\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // One line, no stack — the same contract as src/server/main.ts.
    process.stderr.write(`ordinate: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
