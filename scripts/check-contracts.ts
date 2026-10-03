// Every RPC contract must say what its access is checked against (T3.3): a
// project resolver (`project: (input) => …`) or an explicit org-level
// declaration (`org: true`). The type of `rpc()` already refuses a contract
// with neither; this is the runtime half, which also catches a cast, a
// non-function resolver or an access level outside read|write|admin.
// scripts/test-authz.ts asserts it lists nothing, so it runs in `npm test`.
//
//   npm run build:ts && node scripts/check-contracts.js

import type { Contract } from '../src/api/contract';

const ACCESS = new Set(['read', 'write', 'admin']);

/** Channels whose contract has no usable scope, with why. Empty when every contract is resolvable. */
export function unresolvedContracts(all: Readonly<Record<string, Contract>>): string[] {
  const out: string[] = [];
  for (const [channel, c] of Object.entries(all)) {
    const raw = c as unknown as Record<string, unknown>;
    const project = typeof raw.project === 'function';
    const org = raw.org === true;
    if (!ACCESS.has(String(raw.access))) out.push(`${channel}: access ${String(raw.access)} is not read|write|admin`);
    else if (project === org) out.push(`${channel}: ${project ? 'both a project resolver and org: true' : 'no project resolver and no org: true'}`);
  }
  return out;
}

if (require.main === module) {
  const { contracts } = require('../src/api/index') as typeof import('../src/api/index');
  const bad = unresolvedContracts(contracts);
  console.log(`${Object.keys(contracts).length} contracts, ${bad.length} unresolved`);
  for (const line of bad) console.log(`  ${line}`);
  process.exitCode = bad.length ? 1 : 0;
}
