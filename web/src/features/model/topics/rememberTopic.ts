// The Data model's topic pick (semantic layer part 6, D14): `?topic=` in the URL, else the last one picked in this
// browser for the project (`ordinate.topic:<projectId>`, as the dock keeps `ordinate.dockProject`). Storage can be
// blocked or throw: then the pick lasts for the URL only, and All stands.

import { useSearchParams } from 'react-router';

const key = (projectId: string) => `ordinate.topic:${projectId}`;

export function read(projectId: string): string | null {
  try {
    return localStorage.getItem(key(projectId));
  } catch {
    return null;
  }
}

export function write(projectId: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(key(projectId), id);
    else localStorage.removeItem(key(projectId));
  } catch {
    // storage blocked: the URL still carries the pick
  }
}

/** The picked topic's id (null: All), and the setter both the picker and "Show all" use. */
export function useTopicPick(projectId: string): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const set = (id: string | null) => {
    write(projectId, id);
    setParams((p) => {
      const q = new URLSearchParams(p);
      if (id) q.set('topic', id);
      else q.delete('topic');
      return q;
    }, { replace: true });
  };
  return [params.get('topic') ?? read(projectId), set];
}
