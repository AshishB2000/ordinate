// Capture → dataset. Classic global-scope renderer <script> — NO import/export;
// symbols are shared with the other hub scripts.
//
// A capture becomes a dataset through the ORDINARY path now: draft the extracted
// table in main (captureDataset:draft — the same finalize path every file parser
// runs), then hand it to the COMPOSER as an inline base, exactly as Import and
// Paste do. This file used to build a review-and-correct grid of its own; the
// composer's preview is that grid (editable cells for a capture base — see
// dcCellEdit in composer.ts), so a mis-read cell is fixed in one place.
//
// NOTHING is coerced or computed here — the model EXTRACTS, main COMPUTES.
//
// Consumes: window.hub (bridge), currentProjectId (workspace.ts), showToast
// (hub.ts), openComposer (composer.ts), selectSection (workspace.ts). No fs/Node.

// Module-local recapture handoff. startRecapture() sets this, fires the ordinary
// capture path, and maybeResumeRecapture() (called from hubCapture.ts on a
// result) completes it once the new analysis arrives.
let pendingCaptureTarget: { datasetId: string; mode: 'replace' | 'append' } | null = null;

/**
 * Draft the capture's extracted table in main.
 *
 * ONE projection of an extraction, used twice: the capture page renders it
 * (quietly — opening a page is not the moment to be told about ragged rows),
 * and "Save as dataset" hands the same rows to the composer. A second
 * projection in the renderer would be a second answer to "what did the model
 * read", and the two would drift.
 *
 * `quiet` suppresses the toasts, not the result — a caller that is only
 * DISPLAYING still gets exactly what a caller that is saving would.
 */
// ponytail: the capture entry is a model-shaped envelope — any.
async function captureDraft(
  entry: any,
  opts: { quiet?: boolean } = {},
): Promise<{ columns: any[]; rows: any[][] } | null> {
  const say = (msg: string): void => {
    if (!opts.quiet && typeof showToast === 'function') showToast(msg);
  };
  if (!entry || !entry.result) return null;
  if (!currentProjectId) {
    say('Open a project first.');
    return null;
  }
  let draft: any;
  try {
    draft = await window.hub.captureToDatasetDraft(entry.result.extractedTable);
  } catch (_) {
    draft = null;
  }
  if (!draft || draft.ok === false) {
    say((draft && draft.error) || 'Could not read the extracted table.');
    return null;
  }
  const columns = Array.isArray(draft.columns) ? draft.columns : [];
  if (columns.length === 0) {
    say('That capture had no table to save.');
    return null;
  }
  (Array.isArray(draft.warnings) ? draft.warnings : []).forEach((w: string) => say(String(w)));
  return { columns, rows: Array.isArray(draft.rows) ? draft.rows : [] };
}

/**
 * "Save as dataset" on the capture page: the composer, with this capture's
 * extracted table on the canvas.
 *
 * The composer is the app's ONE create-a-dataset surface — same page, same
 * preview, same field mapping, same Save — so a capture is not a special kind
 * of import, only a source. `origin` is what links the saved dataset back to
 * its screenshot; main resolves the crop path from its own history record (a
 * renderer must never hand main a filesystem path).
 */
async function openCaptureComposer(entry: any): Promise<void> {
  const draft = await captureDraft(entry);
  if (!draft) return;
  const name = (entry.result && entry.result.title) || entry.title || 'Captured data';

  // The model's own caution, said once, where the review happens.
  const conf = entry.result.extractionConfidence;
  const notes = entry.result.extractionNotes;
  if (conf === 'low' || conf === 'medium' || (typeof notes === 'string' && notes.trim())) {
    if (typeof showToast === 'function') {
      showToast('The model was unsure about some values — check them against the screenshot.');
    }
  }

  if (typeof selectSection === 'function') selectSection('datasets');
  openComposer({
    label: String(name),
    rows: draft.rows.length,
    kind: 'capture',
    ref: { inline: { name: String(name), columns: draft.columns, rows: draft.rows } },
    columns: draft.columns.map((c: any) => String(c.name)),
  }, {
    name: String(name),
    sourceKind: 'capture',
    origin: { kind: 'capture', captureId: String(entry.id) },
  });
}

// Kick off a recapture into an existing capture-dataset: remember the target, then
// run the ORDINARY capture path (no change to analyze/dispatch or the capture loop).
function startRecapture(datasetId: string, mode: 'replace' | 'append'): void {
  pendingCaptureTarget = { datasetId, mode };
  doCapture();
  if (!(window.hub && typeof window.hub.takeScreenshot === 'function')) pendingCaptureTarget = null;
}

/**
 * Finish a pending recapture once the new analysis arrives.
 *
 * Recapture does NOT go through the composer: the composer creates a dataset,
 * and this replaces or appends to one the user already reviewed — it is a
 * refresh of the figures, not a new import, and the composer has no notion of
 * a target. So this states exactly what is about to happen and asks, then hands
 * the drafted table to captureDataset:save, which coerces and aligns it in main
 * against the target's own columns.
 */
function maybeResumeRecapture(entry: any): void {
  if (!pendingCaptureTarget) return;
  const target = pendingCaptureTarget;
  pendingCaptureTarget = null;
  if (!captureHasExtractedTable(entry)) {
    if (typeof showToast === 'function') showToast('That capture had no table to add.');
    return;
  }
  void (async () => {
    const draft = await captureDraft(entry);
    if (!draft) return;
    const verb = target.mode === 'replace' ? 'Replace the rows of' : 'Append to';
    const shape = `${draft.rows.length} row${draft.rows.length === 1 ? '' : 's'} × ${draft.columns.length} column${draft.columns.length === 1 ? '' : 's'}`;
    if (!window.confirm(`${verb} this dataset with the ${shape} read from the new screenshot?`)) return;

    let res: any;
    try {
      res = await window.hub.saveCaptureDataset({
        projectId: currentProjectId as string,
        name: '',
        entryId: entry.id,
        columns: draft.columns,
        rows: draft.rows,
        target,
      });
    } catch (_) {
      res = { ok: false, error: 'Failed to update the dataset.' };
    }
    if (!res || res.ok === false) {
      if (typeof showToast === 'function') showToast((res && res.error) || 'Failed to update the dataset.');
      return;
    }
    (Array.isArray(res.warnings) ? res.warnings : []).forEach((w: string) => {
      if (typeof showToast === 'function') showToast(String(w));
    });
    if (typeof showToast === 'function') showToast('Dataset updated from the new screenshot.');
    if (typeof refreshDatasetList === 'function') { try { await refreshDatasetList(); } catch (_) { /* noop */ } }
    if (typeof selectSection === 'function') selectSection('datasets');
  })();
}

// True when an entry's result carries a non-empty extracted table — the gate on
// the capture page's "Save as dataset".
function captureHasExtractedTable(entry: any): boolean {
  const et = entry && entry.result ? entry.result.extractedTable : null;
  return !!(et && Array.isArray(et.columns) && et.columns.length > 0 && Array.isArray(et.rows) && et.rows.length > 0);
}
