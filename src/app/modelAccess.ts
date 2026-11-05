// Who may take the model files in or out (semantic layer part 7, D7): the files hold term values and value labels a row
// access rule withholds, so a caller those rules restrict is refused. One helper for the RPC handlers and the MCP tools.

import { restrictedOn } from '../data/rowAccess';
import { modelRestricted } from './modelFileMessages';

/** The sentence a restricted caller is told, or null when the caller may use the model files on this project. */
export async function modelRefusal(projectId: string): Promise<string | null> {
  return (await restrictedOn(projectId)) ? modelRestricted() : null;
}
