// The composer's Deep research switch and the start of a run (docs/deep-research/00-design.md, "The run" step 1). Shown only to
// editors and admins when AI is ready; a message sent with it on starts a run (`research:start`) in place of `copilot:ask`.
// Off again after a send, so an ordinary question never goes out as research by habit.

import { useState } from 'react';
import { startResearch, useResearchInfo } from './api';

export function useResearch(projectId: string | null, allowed: boolean) {
  const [on, setOn] = useState(false);
  const info = useResearchInfo(projectId, allowed && !!projectId);
  const running = !!info.data?.activeRunId;
  return {
    allowed,
    on: on && allowed && !running,
    setOn,
    /** Why the switch is unavailable right now (a sentence), or null. */
    reason: running ? 'A research run is in progress. Stop it or wait for it to finish.' : null,
    minutes: info.data?.limits?.minutes ?? 10,
    start: startResearch,
    refresh: () => void info.refetch(),
  };
}
export type Research = ReturnType<typeof useResearch>;
