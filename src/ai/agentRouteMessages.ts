import { t } from '../app/i18n';
// What the agent router says about its pick (docs/agent-router/00-design.md) — MAIN, through the catalog. The words are the
// app's, built from the matches it found; no model writes a reason. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

export function routeDataset(name: string): string {
  return t('agentRouteMessages.the_dataset', { name });
}

export function routeColumn(name: string): string {
  return t('agentRouteMessages.the_column', { name });
}

export function routeMetric(name: string): string {
  return t('agentRouteMessages.the_metric', { name });
}

export function routeTerm(name: string): string {
  return t('agentRouteMessages.the_term', { name });
}

export function routeVerified(): string {
  return t('agentRouteMessages.a_verified_question');
}

export function routeDocument(title: string): string {
  return t('agentRouteMessages.the_document', { title });
}

export function routeDescription(): string {
  return t('agentRouteMessages.its_description');
}

export function routeMatchedOne(a: string): string {
  return t('agentRouteMessages.matched', { a });
}

export function routeMatchedTwo(a: string, b: string): string {
  return t('agentRouteMessages.matched_and', { a, b });
}

/** Two agents fit about equally and the small model call chose between their descriptions. */
export function routeModelPicked(): string {
  return t('agentRouteMessages.two_agents_fit_about_equally_so');
}

/** Two agents fit about equally, and there was nobody to ask (a Slack direct message, or no model): the one with more matches. */
export function routeMoreMatches(): string {
  return t('agentRouteMessages.two_agents_fit_about_equally_so_2');
}
