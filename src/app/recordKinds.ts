// The record types a project holds, and where each one lives on disk. MAIN.
//
// Version history, Trash and the project bundle all walk the same kinds of
// record, and a fourth copy of "a dashboard lives in analyses/" is how one of
// them ends up looking in the wrong directory. So the vocabulary lives here once.
//
// `dashboard` is the user's word for an Analysis record; the directory keeps its
// historical name. `alert` is the odd one out: every rule of a project shares one
// alerts.json, so it has no per-record file and no entry in RECORD_DIR.

import * as path from 'path';
import * as appPaths from './paths';
import { isValidId } from './ids';

export type RecordType = 'dataset' | 'visual' | 'dashboard' | 'metric' | 'report' | 'alert' | 'term' | 'verified' | 'topic';
export type FileRecordType = Exclude<RecordType, 'alert'>;

export const RECORD_TYPES: readonly RecordType[] = ['dataset', 'visual', 'dashboard', 'metric', 'report', 'alert', 'term', 'verified', 'topic'];

export const RECORD_DIR: Record<FileRecordType, string> = {
  dataset: 'datasets',
  visual: 'visuals',
  dashboard: 'analyses',
  metric: 'metrics',
  report: 'reports',
  term: 'terms', // a glossary term (semantic D10)
  verified: 'verified', // a verified question (semantic part 3 D7): a spec, never a figure
  topic: 'topics', // a team's short list of the project's data (semantic part 6 D14); no version history
};

export function isRecordType(v: unknown): v is RecordType {
  return typeof v === 'string' && (RECORD_TYPES as readonly string[]).includes(v);
}

export function projectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
}

/** userData/projects/<id>, or '' for anything that is not a UUID — never a path
 *  built from an unchecked id. */
export function projectDir(projectId: unknown): string {
  return isValidId(projectId) ? path.join(projectsBase(), projectId) : '';
}

export { isValidId };
