import { useQuery } from '@tanstack/react-query';
import { rpc } from './client';

/** What `projects:list` returns per project — the fields the web reads (src/app/projects.ts `Project`). */
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
