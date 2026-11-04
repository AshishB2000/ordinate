// Who may see a dataset's source names: its warehouse table, host, database, SQL and URL
// (docs/semantic-layer/02-source-tables.md, D13). The rule is "can open the connection":
// a project editor or admin does, a viewer does not. Every reply that carries a source name
// asks here, so the answer is one place. Fails closed: a role lookup that throws, or an id that is not a project id, is a viewer.

import { isValidId } from '../app/ids';
import { restrictedOn } from './rowAccess';

export async function seesSourceNames(projectId: string): Promise<boolean> {
  // restrictedOn answers "unrestricted" for an id that is not a project id: a bad id must not read names.
  return isValidId(projectId) && !(await restrictedOn(projectId).catch(() => true));
}
