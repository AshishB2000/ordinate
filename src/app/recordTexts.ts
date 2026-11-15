// Several records read in ONE query (./recordFs readMany), for the stores' getters, which take a record's text in place of
// a readFile (datasets.getDatasetMeta, terms.getTerm). MAIN PROCESS ONLY. A record readMany left out reads as readFile's
// ENOENT, so each getter answers as it does for a missing record.

import * as recordFs from './recordFs';

/** `textOf(path)`: what readFile gives for that record, or the ENOENT it throws. `perQuery`: readMany's. */
export async function readTexts(paths: readonly string[], perQuery?: number): Promise<(path: string) => () => string> {
  const bodies = await recordFs.readMany([...new Set(paths)], perQuery);
  return (p) => () => {
    const body = bodies.get(p);
    if (body === undefined) throw Object.assign(new Error('no such record'), { code: 'ENOENT' });
    return body;
  };
}

/** The body at `path` from `textOf`, or null: for a parser that takes the body itself (metrics.summaryOf). */
export function bodyOf(textOf: (path: string) => () => string, path: string): string | null {
  try {
    return textOf(path)();
  } catch (_) {
    return null;
  }
}
