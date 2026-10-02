// Additive globals for the event-annotation scripts (chartEvents.ts,
// eventsPage.ts) — kept apart from the shared globals.d.ts so concurrent
// branches do not collide on it. Classic-script functions need no declaration;
// only the preload bridge does.

// preload/hubEventsPreload.ts — methods mirror the contextBridge surface 1:1.
// ponytail: IPC envelopes typed loosely (any), as for window.hub.
interface Window {
  hubEvents: {
    list(projectId: string): Promise<any>;
    save(projectId: string, event: any): Promise<any>;
    remove(projectId: string, id: string): Promise<any>;
    importCsv(projectId: string, text: string): Promise<any>;
    setCalendars(projectId: string, calendars: string[]): Promise<any>;
  };
}

// chartRender.ts's chart payload, widened by declaration merging: main's
// `data.events` (src/analysis/events.ts EventMark[]) rides on a chart reply.
interface ChartDataShape {
  events?: EvMark[];
}
