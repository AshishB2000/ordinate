// IdP groups decide role and teams (docs/sso-lifecycle/00-design.md §7.1).
//
// Part 1 (no database): the pure mapping, the claim and header readers, the
// digest and the environment parsers.
// Part 2 (DATABASE_URL): sign-in end to end — OIDC through scripts/mockOidc.ts
// and header mode over injected peers — the fail-open traps with their
// negative controls, the managed-role refusals, the last-admin rule under a
// deterministic race, the audit trail and the teams memo.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-idpGroups.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const idp: typeof import('../src/server/auth/idpGroups') = require('../src/server/auth/idpGroups');
const idpEnv: typeof import('../src/server/idpEnv') = require('../src/server/idpEnv');
const envMod: typeof import('../src/server/env') = require('../src/server/env');

type Mapping = import('../src/server/auth/idpGroups').GroupMapping;
const throws = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (err) {
    return re.test((err as Error).message);
  }
};

function pure(): void {
  // ── a. The mapping ─────────────────────────────────────────────────────
  const T1 = '11111111-1111-4111-8111-111111111111';
  const T2 = '22222222-2222-4222-8222-222222222222';
  const map: Mapping[] = [
    { group: 'bi-admins', role: 'admin', teamId: null },
    { group: 'bi-editors', role: 'editor', teamId: T1 },
    { group: 'analysts', role: null, teamId: T2 },
  ];
  const m = (groups: string[], bg = false) => idp.rolesAndTeams(groups, map, bg);
  ok('mapping: the highest mapped role wins', m(['bi-editors', 'bi-admins']).role === 'admin' && m(['bi-editors']).role === 'editor');
  ok('mapping: no mapped group is a viewer', m(['marketing']).role === 'viewer' && m([]).role === 'viewer');
  ok('mapping: break-glass is admin whatever the groups', m([], true).role === 'admin' && m(['bi-editors'], true).role === 'admin');
  ok('mapping: linked teams are exactly the matched groups\' teams', JSON.stringify(m(['bi-editors', 'analysts']).teams) === JSON.stringify([T1, T2].sort()) && m(['bi-admins']).teams.length === 0);
  ok('mapping: every linked team is listed (the only ones a sync touches)', JSON.stringify(m([]).linked) === JSON.stringify([T1, T2].sort()));
  const teamsOnly: Mapping[] = [{ group: 'analysts', role: null, teamId: T2 }];
  ok('mapping: no role row → roles are manual (null), break-glass still admin', idp.rolesAndTeams(['analysts'], teamsOnly, false).role === null && idp.rolesAndTeams([], teamsOnly, true).role === 'admin');
  ok('last admin: kept when no other signed-in admin remains', idp.keepLastAdmin('admin', 'viewer', 0) === 'admin');
  ok('NEGATIVE CONTROL: a second signed-in admin lets the demotion through', idp.keepLastAdmin('admin', 'viewer', 1) === 'viewer');
  ok('last admin: a non-admin is never "kept"', idp.keepLastAdmin('editor', 'viewer', 0) === 'viewer');
  ok('canonical: NFC and trimmed, deduplicated and sorted', JSON.stringify(idp.canonGroups([' b ', 'a', 'Café', 'a', ''])) === JSON.stringify(['Café', 'a', 'b'].sort()));
  ok('matching is case-sensitive: "Admins" is not "admins"', m(['BI-Admins']).role === 'viewer');
  ok('NEGATIVE CONTROL: the exact name matches', m(['bi-admins']).role === 'admin');

  // ── b. Reading the claim and the header ───────────────────────────────
  const g = (claims: Record<string, unknown> | undefined, name = 'groups') => JSON.stringify(idp.groupsFromClaims(claims, name));
  ok('claim: absent / null / number / object / boolean → absent', [{}, { groups: null }, { groups: 3 }, { groups: { a: 1 } }, { groups: true }, undefined].every((c) => g(c) === '"absent"'));
  ok('claim: an array holding a non-string → absent, never a partial list', g({ groups: ['a', 2] }) === '"absent"');
  ok('claim: a string is one group; an array the list', g({ groups: 'a' }) === '["a"]' && g({ groups: ['b', 'a'] }) === '["a","b"]');
  ok('claim: an explicit empty list is [] (it changes things)', g({ groups: [] }) === '[]');
  ok('claim: Entra overage (`_claim_names` naming the claim) → overage, even with a list', g({ _claim_names: { groups: 'src1' }, groups: ['a'] }) === '"overage"');
  ok('claim: `hasgroups` → overage for the groups claim', g({ hasgroups: true }) === '"overage"' && g({ hasgroups: 'true' }) === '"overage"');
  ok('claim: `hasgroups` is about groups, not app roles', g({ hasgroups: true, roles: ['a'] }, 'roles') === '["a"]');
  ok('claim: `_claim_names` naming another claim is not this claim\'s overage', g({ _claim_names: { groups: 'src1' }, roles: ['a'] }, 'roles') === '["a"]');
  ok('claim: a namespaced top-level claim is read as one key', g({ 'https://acme.test/groups': ['a'] }, 'https://acme.test/groups') === '["a"]');
  ok('header: missing → absent; empty → []; comma-separated, trimmed', JSON.stringify(idp.groupsFromHeader(undefined)) === '"absent"'
    && JSON.stringify(idp.groupsFromHeader('')) === '[]' && JSON.stringify(idp.groupsFromHeader('b, a ,,a')) === '["a","b"]');
  ok('digest: order-free, and the break-glass flag counts', idp.digestOf(['a', 'b'], false) === idp.digestOf(idp.canonGroups(['b', 'a']), false) && idp.digestOf(['a'], true) !== idp.digestOf(['a'], false));

  // ── k. Environment ─────────────────────────────────────────────────────
  const base = { LOG_LEVEL: 'silent', DATABASE_URL: 'postgres://x@127.0.0.1/x' };
  const oidc = { ...base, AUTH_MODE: 'oidc', OIDC_ISSUER: 'http://127.0.0.1:1', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_REDIRECT_URL: 'http://127.0.0.1:1/api/auth/callback' };
  const header = { ...base, AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32' };
  const parsed = envMod.parseEnv({ ...oidc, OIDC_GROUPS_CLAIM: 'groups', OIDC_EXTRA_SCOPES: 'groups, openid offline_access groups' });
  ok('env: OIDC_GROUPS_CLAIM and OIDC_EXTRA_SCOPES (deduplicated, the always-sent ones dropped)',
    JSON.stringify(parsed.auth.groupsFrom) === '{"claim":"groups"}' && JSON.stringify(parsed.auth.oidc?.extraScopes) === '["groups","offline_access"]');
  ok('env: TRUSTED_GROUPS_HEADER is lower-cased', JSON.stringify(envMod.parseEnv({ ...header, TRUSTED_GROUPS_HEADER: 'X-Forwarded-Groups' }).auth.groupsFrom) === '{"header":"x-forwarded-groups"}');
  ok('env: unset → groups are not read; tokens live 365 days', envMod.parseEnv(header).auth.groupsFrom === null && envMod.parseEnv(header).auth.apiTokenMaxDays === 365);
  ok('env: OIDC_GROUPS_CLAIM under header mode refuses to start', throws(() => envMod.parseEnv({ ...header, OIDC_GROUPS_CLAIM: 'groups' }), /OIDC_GROUPS_CLAIM is read only when AUTH_MODE=oidc/));
  ok('env: TRUSTED_GROUPS_HEADER under oidc refuses to start', throws(() => envMod.parseEnv({ ...oidc, TRUSTED_GROUPS_HEADER: 'x-groups' }), /TRUSTED_GROUPS_HEADER is read only/));
  ok('env: OIDC_EXTRA_SCOPES under header mode refuses to start', throws(() => envMod.parseEnv({ ...header, OIDC_EXTRA_SCOPES: 'groups' }), /OIDC_EXTRA_SCOPES is read only/));
  ok('env: a header name with a space, or X-Forwarded-Email itself, refuses to start',
    throws(() => idpEnv.groupsFrom('header', undefined, 'x groups'), /header name/) && throws(() => idpEnv.groupsFrom('header', undefined, 'X-Forwarded-Email'), /already means/));
  ok('env: a scope with a quote refuses to start', throws(() => idpEnv.extraScopes('oidc', 'a"b'), /not a scope/));
  ok('env: API_TOKEN_MAX_DAYS 0, 3651 and "x" refuse; 1 and 3650 parse',
    ['0', '3651', 'x', '1.5'].every((v) => throws(() => idpEnv.apiTokenMaxDays(v), /API_TOKEN_MAX_DAYS/)) && idpEnv.apiTokenMaxDays('1') === 1 && idpEnv.apiTokenMaxDays('3650') === 3650);
}

(async () => {
  pure();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
