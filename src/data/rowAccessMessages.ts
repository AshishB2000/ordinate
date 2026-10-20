// What a person reads about row access rules (docs/row-policy/00-design.md,
// "Refusals") — MAIN, through the catalog. Its own file so the i18n extractor
// scans only sentences. Fixed sentences: a refusal never names another team,
// person or value, and the RPC route recognises a caught refusal by its sentence.

/** No rule names the caller or a team they are in (or every value was blank). */
export function rowNoneMessage(): string {
  return "You don't have access to any rows of this dataset. A project admin can give you access.";
}

/** The rule column is gone, not text, or missing from the warehouse. */
export function rowColumnMessage(): string {
  return "This dataset's row access rules name a column it no longer has, so it is closed to you until a project admin fixes them.";
}

/** Stored cross-row values, a parameter in the steps, or a changed writer of the rule column. */
export function rowPipelineMessage(): string {
  return "This dataset stores values computed across all of its rows, so it can't be limited to the rows you can see.";
}

/** A reader that is not one of the locked doors. */
export function rowReaderMessage(): string {
  return "This reads the whole dataset, and your access covers only some of its rows, so it's off for you.";
}

/** A column or label reached through a relationship. */
export function rowRelatedMessage(): string {
  return "This question reaches a related dataset, and row access rules don't extend across relationships yet.";
}

/** An as-of read. */
export function rowAsOfMessage(): string {
  return 'Looking at past data is off for datasets with row access rules.';
}

/** Publish, embed, subscription, alert. */
export function rowFanOutMessage(): string {
  return "This reads a dataset with row access rules. Published links, embeds, subscriptions and alerts show the same figures to everyone, so they're off for it.";
}

/** An export by a restricted caller. */
export function rowExportMessage(): string {
  return 'Exports are off for datasets with row access rules while your access covers only some of its rows.';
}

/** A dataset with no rules of its own, built from one that has them. */
export function rowDerivedMessage(): string {
  return "This dataset is built from a dataset with row access rules, so it's closed to you until a project admin gives it rules of its own.";
}

/** Rules need the user directory. */
export function rowNeedsDatabaseMessage(): string {
  return 'Row access rules need the server\'s user directory (DATABASE_URL).';
}

/** A rule names someone who is not a user or team of this organization. */
export function rowUnknownMemberMessage(): string {
  return 'A rule names someone who is not a user or a team of this organization.';
}

/** The chosen column is not a text column of the dataset. */
export function rowBadColumnMessage(): string {
  return 'Pick a text column of this dataset for the rules.';
}

/** A rule's values are missing or invalid. */
export function rowBadValuesMessage(): string {
  return 'Each rule needs at least one value, and a value cannot be blank or name a parameter.';
}
