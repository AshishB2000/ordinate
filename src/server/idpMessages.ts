import { t } from '../app/i18n';
// What Admin → People says when the identity provider decides a role or a
// team (docs/sso-lifecycle/00-design.md) — MAIN, through the catalog. Its own
// file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these
// sentences and nothing else.

/** admin:setRole on a member whose role follows their identity provider groups. */
export function roleFromIdp(): string {
  return t('idpMessages.this_person_s_role_comes_from');
}

/** admin:teamMember on a team linked to an identity provider group. */
export function teamFromIdp(): string {
  return t('idpMessages.this_team_s_members_come_from');
}
