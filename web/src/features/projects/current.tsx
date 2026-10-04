// The CURRENT PROJECT — the convention every project-scoped screen (T2.3+)
// reads, instead of each asking "which project am I in" its own way:
//
//   const { projectId, project } = useCurrentProject();
//
// `projectId` is null only while the switcher's list loads, or when the
// caller can open no project at all (render the "no project" empty state).
// Which project it is, in order:
//
//   1. `?project=<id>` in the URL — a shareable deep link; honoured on load
//      and whenever an in-app link carries it.
//   2. What this browser last switched to (localStorage `ordinate.project`).
//   3. The most recently opened project the caller can read.
//
// An archived, deleted or no-longer-shared id falls through to the next rule,
// so a stale choice never strands a screen. `select(id)` switches (and stamps
// "last opened" on the server). A page whose URL names its project itself —
// `/data/:projectId/:datasetId`, `/versions/:projectId/…` — calls
// `useAdoptProject(projectId)` so the switcher agrees with the page.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { byRecent, useOverview, type ProjectRow } from './api';

const KEY = 'ordinate.project';

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // storage blocked: rule 3 decides
  }
}

export interface CurrentProject {
  projectId: string | null;
  project: ProjectRow | null;
  /** Every project the caller can read, most recently opened first (archived included). */
  projects: readonly ProjectRow[];
  status: 'pending' | 'error' | 'success';
  error: Error | null;
  refetch(): void;
  select(id: string): void;
}

const Ctx = createContext<CurrentProject | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const overview = useOverview();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const asked = params.get('project');
  const [chosen, setChosen] = useState<string | null>(() => asked ?? stored());
  // An in-app link carrying ?project= switches, like a fresh load would.
  useEffect(() => {
    if (asked) setChosen(asked);
  }, [asked]);

  const select = useCallback(
    (id: string) => {
      setChosen(id);
      try {
        localStorage.setItem(KEY, id);
      } catch {
        // blocked storage: this tab still switches
      }
      // Best effort: the stamp only orders the switcher.
      rpc('projects:open', { id }).then(
        () => void client.invalidateQueries({ queryKey: ['projects:overview'] }),
        () => undefined,
      );
    },
    [client],
  );

  const value = useMemo<CurrentProject>(() => {
    const projects = byRecent(overview.data ?? []);
    const live = projects.filter((p) => !p.archived);
    const project = live.find((p) => p.id === chosen) ?? live[0] ?? null;
    return {
      projectId: project?.id ?? null,
      project,
      projects,
      status: overview.status,
      error: overview.error,
      refetch: () => void overview.refetch(),
      select,
    };
  }, [overview, chosen, select]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrentProject(): CurrentProject {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCurrentProject() outside <ProjectProvider> (the shell provides it)');
  return c;
}

/** A page whose URL names its project: make it the current one, so the switcher shows it. */
export function useAdoptProject(projectId: string | undefined): void {
  const { projectId: current, projects, select } = useCurrentProject();
  const known = projects.some((p) => p.id === projectId && !p.archived);
  useEffect(() => {
    if (projectId && known && projectId !== current) select(projectId);
  }, [projectId, known, current, select]);
}
