// The rail's sections, grouped by what you came to do (docs/design-floor §5).
// nav.ts is append-only and keeps the routes; this file places each one. The
// foot (Settings, Admin, Trash) is nav.ts's `bottom`, as it always was.
// navGroups.test.ts fails on a main route in no group or in two.

export interface NavGroup {
  readonly label: string;
  /** NAV routes (`to`), top to bottom. */
  readonly items: readonly string[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { label: 'View', items: ['/', '/explore', '/dashboards', '/reports'] },
  { label: 'Build', items: ['/data', '/connections', '/pipelines', '/visuals', '/analyses', '/analytics'] },
];
