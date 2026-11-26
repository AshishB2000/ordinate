// The Assistant's setup address (SetupPage.tsx), its own module so a link to it does not pull the page into a chunk.

/** The setup address for a project, keeping the rest of a query (`agent`, `issue`); `tab` and `project` are dropped. */
export function setupPath(projectId: string, search = ''): string {
  const q = new URLSearchParams(search);
  q.delete('tab');
  q.delete('project');
  const rest = q.toString();
  return `/assistant/setup/${projectId}${rest ? `?${rest}` : ''}`;
}
