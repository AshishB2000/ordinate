import { t } from '../app/i18n';
// What an admin reads about connection tables per team (docs/team-folders/00-design.md, "Connection tables per team") —
// MAIN, through the catalog. Its own file so the i18n extractor scans only sentences.

/** The team channels without Postgres: there are no teams. */
export function teamTablesNeedDatabase(): string {
  return t('teamTableMessages.tables_for_teams_need_a_database');
}

/** A team id that is not one of the organization's (deleted since the page loaded). */
export function teamTablesTeamGone(): string {
  return t('teamTableMessages.that_team_is_no_longer_in');
}
