// Additive globals for the authoring-depth scripts (same arrangement as
// globals.hub-c.d.ts: kept apart from the shared globals.d.ts so concurrent
// branches do not collide on it). Only symbols that are NOT function
// declarations need one here — a classic script's functions are visible to
// the others through the shared program.

// renderer/hub/cardModel.ts attaches this to window (UMD, the geoMatch pattern).
// ponytail: its shapes are validated inside the module; callers treat it as a namespace
declare const cardModel: any;

// renderer/hub/markdown.ts (UMD): the text card's Markdown subset.
// ponytail: the block/inline AST is internal to markdown.ts
declare function mdParse(src: unknown): any[];
declare function mdRender(blocks: any[], doc: Document, hooks?: any): DocumentFragment;
declare function mdTokens(src: unknown): string[];

// renderer/hub/geoCluster.ts (UMD): lat/long detection and grid clustering.
// ponytail: shapes documented in geoCluster.ts; typed loosely across the UMD boundary
declare const geoCluster: any;
