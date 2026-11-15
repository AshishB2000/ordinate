import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Shared folders (docs/team-folders/00-design.md). E2 ships the one channel a reader needs; the folder channels
// themselves (tree, create, grant, move …) are E7's, after a release with every reader (D22).
export const folders = {
  // preload: invoke('folder:of', { projectId, kind, id })
  // A bookmarked dataset, dashboard, story or report that loaded nothing: is it in a folder the caller cannot open? `{ok:false,
  // code:'folder', reason:'closed'}` when it exists there, `{ok:true}` otherwise (open, or no such item). It says that
  // something exists, never what (D12, a ceiling).
  'folder:of': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, kind: z.enum(['dataset', 'dashboard', 'story', 'report']), id: Uuid }), project: byProjectId }),
} as const;
