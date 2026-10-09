-- AI models (docs/ai-models/00-plan.md §3, src/server/aiConfig.ts): the org's
-- connected providers, the exact models members may use, and each member's
-- pick. Before this, everything but the key was in a per-pod config.json, so
-- with 2+ pods an admin connected on one and the others said "not set up".
--
-- Additive only: four new tables. org_settings.ai_providers stays; it is read
-- once, by the legacy import, and never again.
--
-- org_id is text, as in 0007_records.sql (dev mode's org is the literal
-- `default`).

-- A connected provider. The API key is NOT here: it is in the secrets store
-- (0002), (org, 'ai.apiKey', provider). verified_at is the last passing
-- connection test; NULL = saved but not connected (its models are hidden).
CREATE TABLE org_ai_providers (
  org_id      text        NOT NULL,
  provider    text        NOT NULL,           -- zod-validated: anthropic|openai|gemini|gateway
  base_url    text        NOT NULL DEFAULT '',
  verified_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider)
);

-- The models members may pick, in list order. Exactly one default per org.
CREATE TABLE org_ai_models (
  org_id     text    NOT NULL,
  provider   text    NOT NULL,
  model      text    NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  label      text    NOT NULL,                 -- the provider's display name, or the id
  position   integer NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, provider, model),
  FOREIGN KEY (org_id, provider) REFERENCES org_ai_providers ON DELETE CASCADE
);
CREATE UNIQUE INDEX org_ai_models_one_default ON org_ai_models (org_id) WHERE is_default;

-- Each member's pick. The request context knows a member by email (as
-- config.starredFor does), so the pick is keyed by it. Removing the model
-- removes the pick → the member gets the org default.
CREATE TABLE user_ai_model (
  org_id     text NOT NULL,
  user_email text NOT NULL,
  provider   text NOT NULL,
  model      text NOT NULL,
  PRIMARY KEY (org_id, user_email),
  FOREIGN KEY (org_id, provider, model) REFERENCES org_ai_models ON DELETE CASCADE
);

-- One row once an org's old config.json byok block has been imported (or
-- found empty), so a later "no providers" — an admin disconnected them all —
-- never re-imports. The primary key is the race guard: two pods importing at
-- once, one inserts and imports, the other waits and finds the row.
CREATE TABLE org_ai_imports (
  org_id      text        PRIMARY KEY,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Defence in depth, forced as on records (0007): every statement in
-- aiConfig.ts already names its org; this holds for one that forgets to.
-- The module sets `ordinate.org` per transaction; unset → NULL → no rows.
ALTER TABLE org_ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_ai_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_ai_providers_org ON org_ai_providers
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE org_ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_ai_models FORCE ROW LEVEL SECURITY;
CREATE POLICY org_ai_models_org ON org_ai_models
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE user_ai_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_ai_model FORCE ROW LEVEL SECURITY;
CREATE POLICY user_ai_model_org ON user_ai_model
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));

ALTER TABLE org_ai_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_ai_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY org_ai_imports_org ON org_ai_imports
  USING (org_id = current_setting('ordinate.org', true))
  WITH CHECK (org_id = current_setting('ordinate.org', true));
