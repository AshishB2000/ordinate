import { useQuery } from '@tanstack/react-query';
import { rpc } from './client';

/**
 * What `projects:list` returns per project — the fields the web reads, mirrored
 * from src/app/projects.ts `Project`. Contracts carry inputs only, and that
 * module's import graph (Electron, fs) cannot be type-checked in the browser
 * world, so the result is narrowed here by hand.
 */
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  lastOpenedAt?: string;
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects:list'],
    queryFn: async () => (await rpc('projects:list')) as Project[],
  });
}
