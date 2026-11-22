// Data model → Proposals (editors): the definitions the Assistant drafted from refused answers, waiting for a decision
// (docs/metric-proposals/00-design.md). Open ones first; a switch shows what was decided.

import { useState } from 'react';
import { EmptyState, ErrorState } from '../../../ui/States';
import { SkeletonRows } from '../../../ui/Skeleton';
import { Tab, TabList, TabPanel, Tabs } from '../../../ui/Tabs';
import { useProposals } from './api';
import { ProposalCard } from './ProposalCard';
import s from './Proposals.module.css';

function Queue({ projectId, decided }: { projectId: string; decided: boolean }) {
  const q = useProposals(projectId, decided);
  if (q.isPending) return <SkeletonRows rows={3} label="Loading proposals" />;
  if (q.isError) return <ErrorState title="Could not load the proposals" message={q.error.message} onRetry={() => void q.refetch()} />;
  if (!q.data.length) {
    return decided ? (
      <EmptyState icon="circle-check" title="Nothing decided yet">Approved and declined proposals will be listed here.</EmptyState>
    ) : (
      <EmptyState icon="sparkles" title="No proposals waiting">
        When someone asks the Assistant something that depends on a name nobody defined, like “gross margin”, they can propose a definition. It appears here for you to approve, edit or decline.
      </EmptyState>
    );
  }
  return <ul className={s.list} aria-label={decided ? 'Decided proposals' : 'Open proposals'}>{q.data.map((p) => <ProposalCard key={p.id} projectId={projectId} p={p} />)}</ul>;
}

export function ProposalsTab({ projectId }: { projectId: string }) {
  const [view, setView] = useState('open');
  return (
    <>
      <p className={s.lede}>
        Definitions the Assistant drafted when a question could not be answered. Each preview is computed for you, under your own access. Approving saves it as an ordinary metric or term.
      </p>
      <Tabs value={view} onValueChange={setView}>
        <TabList label="Proposals">
          <Tab value="open">Waiting</Tab>
          <Tab value="decided">Decided</Tab>
        </TabList>
        <TabPanel value="open"><Queue projectId={projectId} decided={false} /></TabPanel>
        <TabPanel value="decided"><Queue projectId={projectId} decided /></TabPanel>
      </Tabs>
    </>
  );
}

export default ProposalsTab;
