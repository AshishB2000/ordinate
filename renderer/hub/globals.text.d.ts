// Additive globals for the text-analytics scripts (textProfile.ts, textSteps.ts,
// wordCloudLayout.ts, wordCloudRender.ts) — kept apart from the shared
// globals.d.ts so concurrent branches do not collide on it. What needs a line
// here is what the page GETS from outside a script's own top level: the
// preload bridge, and the two functions wordCloudLayout.js attaches to window
// from inside its IIFE.

// The text bridge (preload/hubTextPreload.ts → src/ipc/text.ts).
// ponytail: IPC envelopes typed loosely, as window.hub is
interface Window {
  hubText: {
    profile(projectId: string, datasetId: string, column: string, lang?: string): Promise<any>;
    preview(projectId: string, datasetId: string, index: number, step: any): Promise<any>;
    commitStep(projectId: string, datasetId: string, index: number, step: any): Promise<any>;
  };
}

// wordCloudLayout.js — the IIFE pattern chartShapes.js uses; its shapes are declared there.
declare function wordCloudLayout(words: Array<{ text: string; weight: number }>, opts: WcOptions): WcLayout;
declare function wordCloudHit(layout: WcLayout, x: number, y: number): WcPlaced | null;
declare function wordCloudIsBucket(labels: any[], i: number): boolean;
