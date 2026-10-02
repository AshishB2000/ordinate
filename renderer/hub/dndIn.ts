// Bringing things IN by drag and drop and paste. Classic global-scope renderer
// <script>; main does every check (src/ipc/dragDrop.ts, src/app/dropImport.ts).
//
//   Files dropped anywhere  → one full-window overlay naming what will happen,
//                             then main sniffs each file BY CONTENT and imports
//                             it (data → a dataset job each; .ordinate → a new
//                             project; GeoJSON → boundaries) or refuses it with
//                             a toast naming the file and why
//   Over a map's settings   → "Add boundaries to this map": the encoding form
//                             (encodingMap.ts) marks its rows data-drop-zone=
//                             "boundaries" and listens for the result
//   Paste an image          → on Home or Data, a screenshot capture of it
//   Paste a table's text    → on Data, the composer, prefilled
//
// Local drop zones (the composer canvas, the tab strip, a report's pages) keep
// their own drags: they carry no Files, and this file only acts on Files.

let dndDepth = 0;
let dndOverlay: HTMLElement | null = null;
let dndIdle = 0;

function dndIsFileDrag(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
}

function dndProjectName(): string {
  const el = document.getElementById('ws-project-name');
  return (el && el.textContent ? el.textContent.trim() : '') || t('dndIn.this_project');
}

function dndZoneOf(target: EventTarget | null): HTMLElement | null {
  const el = target as Element | null;
  return el && el.closest ? el.closest('[data-drop-zone="boundaries"]') as HTMLElement | null : null;
}

/**
 * What a drop would do, from what a dragover can see — the item COUNT and MIME
 * types, never contents. Main decides on drop; this only has to be honest.
 */
function dndDescribe(e: DragEvent): { title: string; sub: string; icon: string } {
  const items = Array.from(e.dataTransfer ? e.dataTransfer.items || [] : []).filter((i) => i.kind === 'file');
  const n = items.length || 1;
  const files = n === 1 ? t('dndIn.1_file') : n + ' files';
  if (dndZoneOf(e.target)) return { title: t('dndIn.add_boundaries_to_this_map'), sub: t('dndIn.a_geojson_file_of_regions_joined'), icon: 'map' };
  if (items.length && items.every((i) => /^image\//.test(i.type))) {
    return { title: t('dndIn.images_cannot_be_imported'), sub: t('dndIn.paste_a_screenshot_on_home_or'), icon: 'camera' };
  }
  if (!currentProjectId) return { title: t('dndIn.open_in_ordinate', { files }), sub: t('dndIn.a_ordinate_bundle_opens_as_a'), icon: 'package' };
  const sub = items.some((i) => !i.type)
    ? t('dndIn.csv_excel_json_and_parquet_become')
    : t('dndIn.each_file_becomes_a_dataset_they');
  return { title: t('dndIn.import_into', { files, p1: dndProjectName() }), sub, icon: 'upload' };
}

function dndShow(e: DragEvent): void {
  if (!dndOverlay) return;
  const d = dndDescribe(e);
  const ic = dndOverlay.querySelector('.dnd-icon') as HTMLElement;
  ic.innerHTML = '';
  ic.appendChild(icon(d.icon, 20));
  (dndOverlay.querySelector('.dnd-title') as HTMLElement).textContent = d.title;
  (dndOverlay.querySelector('.dnd-sub') as HTMLElement).textContent = d.sub;
  dndOverlay.classList.toggle('is-zone', !!dndZoneOf(e.target));
  dndOverlay.hidden = false;
}

function dndHide(): void {
  dndDepth = 0;
  if (dndOverlay) dndOverlay.hidden = true;
}

/** Hand dropped files to main and report every outcome. */
async function dndDropFiles(files: File[], zone: HTMLElement | null): Promise<void> {
  if (!files.length) return;
  showToast(files.length === 1 ? t('dndIn.reading', { p0: files[0].name }) : t('dndIn.importing_files', { filesCount: files.length }));
  let res: any = null;
  try { res = await window.hubDrop.dropFiles(files, currentProjectId); } catch (_) { res = null; }
  if (!res || !res.ok) { showToast((res && res.error) || t('dndIn.those_files_could_not_be_read'), { kind: 'error' }); return; }
  const results: any[] = res.results || [];
  for (const r of results) if (!r.ok) showToast(r.error || t('dndIn.could_not_be_imported', { name: r.name }), { kind: 'error' });
  if (res.skipped) showToast(t('dndIn.more_files_were_left_out_drop', { skipped: res.skipped }), { kind: 'error' });

  const data = results.filter((r) => r.ok && r.datasetId);
  if (data.length === 1) {
    const d = data[0];
    showToast(t('dndIn.imported_rows', { name: d.name, p1: Number(d.rowCount || 0).toLocaleString() }), {
      kind: 'success',
      action: { label: t('common.open'), onClick: () => { selectSection('datasets'); void openSavedDataset(d.datasetId); } },
    });
  } else if (data.length > 1) showToast(t('dndIn.imported_datasets', { dataCount: data.length }), { kind: 'success' });
  if (data.length && currentSection === 'datasets') await refreshDatasetList();

  for (const r of results.filter((x) => x.ok && x.boundary)) {
    showToast(t('dndIn.added_regions_from', { featureCount: r.boundary.featureCount, name: r.boundary.name }), { kind: 'success' });
    if (zone) zone.dispatchEvent(new CustomEvent('ordinate:boundaries-added', { detail: r.boundary }));
  }
  const bundle = results.find((r) => r.ok && r.project);
  if (bundle) await pjImport({ ok: true, project: bundle.project, counts: bundle.counts });
}

function dndEditable(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e || !e.tagName) return false;
  return e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
}

/** Two or more lines that split the same way on tabs or commas. */
function dndLooksTabular(text: string): boolean {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 5);
  if (lines.length < 2) return false;
  const count = (l: string, d: string): number => l.split(d).length - 1;
  return ['\t', ','].some((d) => count(lines[0], d) > 0 && count(lines[1], d) === count(lines[0], d));
}

async function dndPasteImage(): Promise<void> {
  let res: any = null;
  try { res = await window.hubDrop.pasteImage(); } catch (_) { res = null; }
  if (!res || !res.ok) { showToast((res && res.error) || t('dndIn.that_image_could_not_be_captured'), { kind: 'error' }); return; }
  // Without a model the capture flow opens Settings → Execution, and main did.
  if (res.notReady) showToast(t('dndIn.capturing_a_screenshot_needs_a_model'));
}

async function dndPasteTable(text: string): Promise<void> {
  let res: any = null;
  try { res = await window.hub.parsePasteDataset(text); } catch (_) { res = null; }
  if (!res || !res.ok || !res.preview || !(res.preview.columns || []).length) {
    showToast((res && res.error) || t('dndIn.the_pasted_text_is_not_a'), { kind: 'error' });
    return;
  }
  dsSourceKind = 'paste';
  dsSuggestedName = t('dsImport.pasted_data');
  dsFilePath = '';
  handOffToComposer(res.preview);
}

function dndOnPaste(e: ClipboardEvent): void {
  if (e.defaultPrevented || !e.clipboardData) return; // an input table's grid took it
  if (dndEditable(e.target) || dndEditable(document.activeElement)) return;
  if (currentSection !== 'home' && currentSection !== 'datasets') return;
  const composer = document.getElementById('ds-composer');
  if (composer && !composer.hidden) return;
  const image = Array.from(e.clipboardData.items || []).some((i) => i.kind === 'file' && /^image\//.test(i.type));
  if (image) { e.preventDefault(); void dndPasteImage(); return; }
  if (currentSection !== 'datasets') return;
  const text = e.clipboardData.getData('text/plain');
  if (!dndLooksTabular(text)) return;
  e.preventDefault();
  void dndPasteTable(text);
}

function initDndIn(): void {
  const ov = document.createElement('div');
  ov.className = 'dnd-overlay';
  ov.hidden = true;
  ov.setAttribute('role', 'status');
  ov.setAttribute('aria-live', 'polite');
  const card = document.createElement('div');
  card.className = 'dnd-card';
  const ic = document.createElement('span');
  ic.className = 'dnd-icon';
  const title = document.createElement('div');
  title.className = 'dnd-title';
  const sub = document.createElement('div');
  sub.className = 'dnd-sub';
  card.append(ic, title, sub);
  ov.appendChild(card);
  document.body.appendChild(ov);
  dndOverlay = ov;

  // Counting enter/leave keeps the overlay from flickering as the pointer
  // crosses child elements.
  document.addEventListener('dragenter', (e) => {
    if (!dndIsFileDrag(e)) return;
    dndDepth++;
    dndShow(e);
  });
  document.addEventListener('dragover', (e) => {
    if (!dndIsFileDrag(e)) return;
    e.preventDefault(); // without it the drop never fires, and Chromium navigates to the file
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dndShow(e);
    // dragover repeats while a drag hovers; a second of silence means it ended
    // somewhere that sent no dragleave (an Escape outside the window).
    window.clearTimeout(dndIdle);
    dndIdle = window.setTimeout(dndHide, 1000);
  });
  document.addEventListener('dragleave', (e) => {
    if (!dndIsFileDrag(e)) return;
    dndDepth = Math.max(0, dndDepth - 1);
    if (dndDepth === 0) dndHide();
  });
  document.addEventListener('drop', (e) => {
    if (!dndIsFileDrag(e)) return;
    e.preventDefault();
    dndHide();
    const files = Array.from(e.dataTransfer ? e.dataTransfer.files : []);
    void dndDropFiles(files, dndZoneOf(e.target));
  });
  document.addEventListener('paste', dndOnPaste);
}

initDndIn();
