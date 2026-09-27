// Additive globals for the typed-filters scripts (filterType.ts,
// filterTypeApply.ts) — kept apart from the shared globals.d.ts, the same
// arrangement as globals.power.d.ts. Classic-script functions need no
// declaration; only the preload bridge does.

// preload/hubFiltersPreload.ts.
// ponytail: IPC envelope typed loosely (any), as for window.hub
interface Window {
  hubFilters: {
    parse(projectId: string, dashboardId: string, text: string, pick?: Record<string, string>): Promise<any>;
  };
}
