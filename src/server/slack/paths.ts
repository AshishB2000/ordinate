// Slack's route patterns, apart from ./routes.ts so ../csrf.ts and ../app.ts can name them without loading the handlers.

export const EVENTS_ROUTE = '/api/slack/events';
export const INTERACTIONS_ROUTE = '/api/slack/interactions';
export const CALLBACK_ROUTE = '/api/slack/connect/callback';
export const CONNECT_ROUTE = '/api/slack/connect';
/** The routes that authorize themselves (the signature or the one-time state row): no sign-in is looked up, and CSRF does not apply. */
export const SELF_AUTH: ReadonlySet<string> = new Set([EVENTS_ROUTE, INTERACTIONS_ROUTE, CALLBACK_ROUTE]);
