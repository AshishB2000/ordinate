import { t } from '../app/i18n';
// What a user reads about AI setup (docs/ai-models/00-plan.md) — MAIN, through
// the catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts
// MAIN_FILES) scans these sentences and nothing else.

/** No model a member may use: nothing connected, no model enabled, or no key store. */
export function aiNotSetUp(): string {
  return t('aiMessages.ai_isn_t_set_up_for');
}

/** ai:setMine with a model the admin has not enabled (or whose provider is not connected). */
export function aiModelNotEnabled(): string {
  return t('aiMessages.that_model_isn_t_one_your');
}

/** ai:setModels naming a provider that is not connected. */
export function aiProviderNotConnected(provider: string): string {
  return t('aiMessages.connect_before_adding_its_models', { provider });
}

/** ai:setModels with the same model twice. */
export function aiModelListedTwice(): string {
  return t('aiMessages.a_model_is_listed_twice');
}

/** ai:setModels whose default is not one of the listed models. */
export function aiNeedsOneDefault(): string {
  return t('aiMessages.choose_one_default_model');
}

/** ai:connect for a provider that needs a key, with none sent and none stored. */
export function aiNeedsKey(): string {
  return t('aiMessages.enter_an_api_key');
}

/** ai:connect for the gateway without a base URL. */
export function aiNeedsBaseUrl(): string {
  return t('aiMessages.enter_the_gateway_s_base_url');
}

/** The gateway has no default model to test with. */
export function aiNeedsGatewayModel(): string {
  return t('aiMessages.enter_a_model_id_to_test');
}
