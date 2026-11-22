// The Data model's Assistant tab (semantic part 3, the owner's answer 1): what the project's editors tell the
// Assistant: its agents (docs/assistant-agents), its instructions, its documents, then its verified questions; an editor then tries a
// question below them (./TestChat). An agent opens its own page in place of the tab's sections (`?agent=` in the URL,
// so a reload or Back keeps it); `new` is a new one.

import { useSearchParams } from 'react-router';
import { useCanEdit } from '../../projects/api';
import { AgentPage } from './AgentPage';
import { AgentsSection } from './AgentsSection';
import { InstructionsList } from './InstructionsList';
import { KnowledgeSection } from './KnowledgeSection';
import { Inbox } from '../../evals/Inbox';
import { TestsSection } from '../../evals/TestsSection';
import { TestChat } from './TestChat';
import { VerifiedList } from './VerifiedList';
import a from './Assistant.module.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function AssistantTab({ projectId }: { projectId: string }) {
  const canEdit = useCanEdit(projectId);
  const [params, setParams] = useSearchParams();
  const asked = params.get('agent') ?? '';
  const agent = asked === 'new' || UUID.test(asked) ? asked : '';
  const open = (id: string, replace = false) =>
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        if (id) q.set('agent', id);
        else q.delete('agent');
        return q;
      },
      { replace },
    );
  if (agent) {
    return (
      <div className={a.tab}>
        <AgentPage projectId={projectId} id={agent} onBack={() => open('')} onCreated={(id) => open(id, true)} />
      </div>
    );
  }
  return (
    <div className={a.tab}>
      <AgentsSection projectId={projectId} onOpen={(id) => open(id)} />
      <InstructionsList projectId={projectId} canEdit={canEdit} />
      <KnowledgeSection projectId={projectId} canEdit={canEdit} />
      <VerifiedList projectId={projectId} canEdit={canEdit} />
      {canEdit && <TestsSection projectId={projectId} agentId={null} />}
      {canEdit && <Inbox projectId={projectId} />}
      {canEdit && <TestChat projectId={projectId} />}
    </div>
  );
}
