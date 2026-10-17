// What a save says when its record lock (./recordFs.ts `locked`) could not
// help it — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** Another save of the same record held it past the lock wait (Postgres 55P03 / 40P01, or the in-process queue). */
export function recordBusy(): string {
  return 'This is being saved by someone else right now. Try again in a moment.';
}

/** A statement inside the locked save failed and was swallowed: Postgres rolled the whole save back. */
export function recordNotSaved(): string {
  return 'This could not be saved. Try again in a moment.';
}
