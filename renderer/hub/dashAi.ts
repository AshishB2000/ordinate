// mkAiPanel — the shared badge + label head every embedded Assistant panel uses
// (the calc-field draft in anDraft.ts, the dock proposals in dockPropose.ts, the
// prepare suggestions in prepare.ts) so they all read identically: an
// "Assistant" badge marking the block as model interpretation, clearly distinct
// from the app-computed facts beside it.
//
// The filename is historical: this file once also held the summarise / explain-
// anomalies actions that ran on a published dashboard. Those were removed with
// the published-Dashboard artifact; the panel head stayed because three other
// surfaces share it. Classic global-scope renderer <script>: no import/export.

function mkAiPanel(labelText: string): HTMLElement {
  const head = document.createElement('div');
  head.className = 'ai-interp-head';
  const badge = document.createElement('span');
  badge.className = 'ai-badge';
  badge.textContent = 'Assistant';
  const label = document.createElement('span');
  label.className = 'ai-interp-label';
  label.textContent = labelText;
  head.appendChild(badge);
  head.appendChild(label);
  return head;
}
