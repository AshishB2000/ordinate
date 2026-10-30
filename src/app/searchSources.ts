// Where the ⌘K name search's records live — pure, no I/O. recordFs asks `sourceOf` on every write
// (a record here updates the index in the same transaction); the index rebuilds a source from
// `sourceRel`. Order is the sidebar's: results read in the order of the app they point into.

export const SOURCES = ['datasets', 'visuals', 'analyses', 'connections', 'metrics', 'reports', 'alerts'] as const;
export type SourceKey = (typeof SOURCES)[number];

export interface RecordSource {
  projectId: string;
  source: SourceKey;
  srcOrd: number;
  /** The record's id from its file name ('' for the one alerts.json). */
  id: string;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const IN_DIR = new RegExp(`^projects/(${UUID})/(datasets|visuals|analyses|connections|metrics|reports)/(${UUID})\\.json$`);
const ALERTS = new RegExp(`^projects/(${UUID})/alerts\\.json$`);
const PROJECT = new RegExp(`^projects/(${UUID})$`);
const WITHIN = new RegExp(`^projects/(${UUID})(?:/|$)`);

/** The source a record path ('/'-separated, relative to userData) belongs to, or null: not searched. */
export function sourceOf(rel: string): RecordSource | null {
  const m = IN_DIR.exec(rel);
  if (m) {
    const source = m[2] as SourceKey;
    return { projectId: m[1].toLowerCase(), source, srcOrd: SOURCES.indexOf(source), id: m[3] };
  }
  const al = ALERTS.exec(rel);
  return al ? { projectId: al[1].toLowerCase(), source: 'alerts', srcOrd: SOURCES.indexOf('alerts'), id: '' } : null;
}

/** A source's records: a directory, or (alerts) one file. */
export function sourceRel(projectId: string, source: SourceKey): string {
  return `projects/${projectId}/${source === 'alerts' ? 'alerts.json' : source}`;
}

/** The project a removed directory IS ('projects/<id>'), or null. */
export function projectOfDir(rel: string): string | null {
  const m = PROJECT.exec(rel);
  return m ? m[1].toLowerCase() : null;
}

/** Above every project: removing this removes every searched record. */
export const isAboveProjects = (rel: string): boolean => rel === '' || rel === 'projects';

/** The project a path is in or is ('projects/<id>' and below), or null: above every project, or elsewhere. */
export function projectIn(rel: string): string | null {
  const m = WITHIN.exec(rel);
  return m ? m[1].toLowerCase() : null;
}
