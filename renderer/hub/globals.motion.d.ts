// Additive globals for linked hover and data transitions (r7:motion) — kept
// apart from the shared globals.d.ts so concurrent branches do not collide on
// it. Classic-script functions need no declaration; what needs one is what the
// two UMD files (motionPlan.ts, kpiTicker.ts) attach to window from inside
// their IIFEs. Their shapes are documented there.

// motionPlan.ts — the label-matched transition plan.
// ponytail: plan entries typed loosely here; motionPlan.ts owns their shape
declare function planTransition(oldLabels: any[], oldValues: any[] | null, newLabels: any[], newValues: any[] | null): {
  enter: any[]; update: any[]; exit: any[]; order: number[]; moved: boolean;
};
declare function exitStep(plan: { update: any[] }, oldValues: any[], newValues: any[]): any[];

// kpiTicker.ts — the KPI figure ticker.
declare function tickValueAt(from: number, to: number, t: number): number;
declare function tickFrames(from: number, to: number, durationMs: number, fps: number, reduced?: boolean): number[];
declare function kpiTick(el: HTMLElement, key: string, to: number | null, text: string, fmt: (v: number) => string): void;
declare function kpiHold(key: string): string;
declare function kpiForget(): void;
