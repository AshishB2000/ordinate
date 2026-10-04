import { useAdoptProject, useCurrentProject } from '../projects/current';

/**
 * The project a Visuals route is about: the one its URL names (adopted as the
 * current project, so the switcher agrees), else the current project. `stale`
 * = the URL names one the caller cannot open.
 */
export function useVisualsProject(routeId: string | undefined) {
  useAdoptProject(routeId);
  const cur = useCurrentProject();
  const known = !!routeId && cur.projects.some((p) => p.id === routeId && !p.archived);
  return { cur, projectId: known ? routeId! : routeId ? null : cur.projectId, stale: !!routeId && cur.status === 'success' && !known };
}
