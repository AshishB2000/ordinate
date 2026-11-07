// The Data model's Assistant tab (semantic part 3, the owner's answer 1): what the project's editors tell the
// Assistant. It holds the instructions; later steps add the verified questions and the test chat below them.

import { useCanEdit } from '../../projects/api';
import { InstructionsList } from './InstructionsList';
import a from './Assistant.module.css';

export function AssistantTab({ projectId }: { projectId: string }) {
  const canEdit = useCanEdit(projectId);
  return (
    <div className={a.tab}>
      <InstructionsList projectId={projectId} canEdit={canEdit} />
    </div>
  );
}
