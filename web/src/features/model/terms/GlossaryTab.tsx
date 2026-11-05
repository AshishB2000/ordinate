// The Data model's Glossary tab: the project's terms (TermsList) with where each is used (`term:usage`).
// A failed or unknown usage read leaves the glossary readable, its Used by reading "—". "New term" is the
// page header's (DataModelPage).

import { useCanEdit } from '../../projects/api';
import { useTermUsage } from './api';
import { TermsList } from './TermsList';

export function GlossaryTab({ projectId }: { projectId: string }) {
  const canEdit = useCanEdit(projectId);
  const usage = useTermUsage(projectId);
  return <TermsList projectId={projectId} canEdit={canEdit} usage={usage.data ?? undefined} />;
}
