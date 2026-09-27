'use strict';

// Sensitivity PROPOSALS where the user meets their data — never applied until
// they say so:
//
//   the composer        a "Personal?" / "Financial?" chip on each flagged
//                       column's header. A choice made here is held until the
//                       dataset exists, then written through privacy:decide.
//   the dataset page    a banner: "2 columns look sensitive — Review", listing
//                       the pending proposals (from import or a later refresh).
//   the column profile  the proposal for that column, or — once it is marked —
//                       what exports do with it and a way to mask it in Prepare.
//
// Detection is main's (src/data/sensitivity.ts); a decision writes the level
// through catalog.setColumn (src/app/privacyStore.decide), where sensitivity has
// always lived. Classic global-scope renderer <script>: no import/export.

const PV_KIND_WORDS: Record<string, string> = {
  email: 'email addresses', phone: 'phone numbers', national_id: 'national ID numbers',
  card_number: 'card numbers', iban: 'bank account numbers', ip_address: 'IP addresses',
  street_address: 'street addresses', person_name: "people's names", birth_date: 'dates of birth',
  salary: 'pay or income',
};
const PV_LEVEL_LABEL: Record<string, string> = { personal: 'Personal', financial: 'Financial' };
// What the EXPORT path does with a marked column; the other three paths are
// one click away in Settings → Privacy.
const PV_ACTION_SENTENCE: Record<string, string> = {
  mask: 'Exports replace its values with project tokens.',
  drop: 'Exports leave it out.',
  include: 'Exports include it — after asking you each time.',
};

function pvEl(tag: string, cls: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function pvBtn(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** "Looks like email addresses" — the proposal's headline. */
function pvProposalTitle(p: any): string {
  return 'Looks like ' + (PV_KIND_WORDS[p.kind] || 'sensitive data');
}

// ── The composer ─────────────────────────────────────────────────────────────

/** raw column name → proposal, from the latest preview. */
let pvDcProposals = new Map<string, any>();
/** raw column name → the user's answer, held until the save gives an id. */
const pvDcDecisions = new Map<string, string>();

function pvComposerReset(): void {
  pvDcProposals = new Map();
  pvDcDecisions.clear();
}

function pvComposerSetProposals(list: any): void {
  pvDcProposals = new Map((Array.isArray(list) ? list : []).map((p: any) => [String(p.column), p]));
}

/** The chip for a preview header, or null when the column was not flagged. */
function pvComposerChip(rawName: string): HTMLElement | null {
  const p = pvDcProposals.get(rawName);
  if (!p) return null;
  const decided = pvDcDecisions.get(rawName);
  if (decided === 'none') return null;
  const level = decided || p.level;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'pv-chip pv-chip--' + level + (decided ? ' is-set' : '');
  chip.appendChild(icon(decided ? 'check' : 'shield', 12));
  chip.appendChild(document.createTextNode(PV_LEVEL_LABEL[level] + (decided ? '' : '?')));
  chip.title = decided ? `Marked ${level} — change` : `${pvProposalTitle(p)}. ${p.reason}`;
  chip.setAttribute('aria-label', decided ? `${rawName}: marked ${level}. Change` : `${rawName}: ${pvProposalTitle(p).toLowerCase()}. Review`);
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openMiniMenu(chip, (menu: HTMLElement, close: () => void) => {
      menu.classList.add('pv-pop');
      menu.appendChild(pvEl('div', 'pv-pop-title', pvProposalTitle(p)));
      menu.appendChild(pvEl('div', 'pv-pop-reason', p.reason));
      const pick = (v: string): void => {
        close();
        pvDcDecisions.set(rawName, v);
        paintGridFromCache();
      };
      const other = level === 'personal' ? 'financial' : 'personal';
      for (const [v, label] of [[level, `Mark as ${level}`], [other, `Mark as ${other}`], ['none', 'Not sensitive']]) {
        const row = pvBtn('chart-menu-item', label, () => pick(v));
        menu.appendChild(row);
      }
      menu.appendChild(pvEl('div', 'pv-pop-foot', 'Nothing is marked until you choose. You can change it later from the column’s details.'));
    });
  });
  return chip;
}

/** After a composer save: write each decision against the SAVED column name. */
async function pvComposerCommit(datasetId: string, savedName: (raw: string) => string | null): Promise<void> {
  if (!currentProjectId || !datasetId || !window.hubPrivacy) return;
  for (const [raw, level] of pvDcDecisions) {
    const name = savedName(raw);
    if (!name) continue;
    try { await window.hubPrivacy.decide(currentProjectId, datasetId, name, level); } catch (_) { /* the proposal stays pending */ }
  }
  pvComposerReset();
}

// ── The dataset page and the profile ─────────────────────────────────────────

/** The open dataset's review, fetched once per open and after each decision. */
let pvReview: { datasetId: string; pending: any[]; levels: Record<string, string>; policy: any } | null = null;
let pvBannerOpen = false;

async function pvLoadReview(datasetId: string): Promise<void> {
  pvReview = null;
  if (!currentProjectId || !datasetId || !window.hubPrivacy) return;
  let r: any = null;
  try { r = await window.hubPrivacy.review(currentProjectId, datasetId); } catch (_) { r = null; }
  if (!r || !r.ok || datasetId !== expId) return;
  pvReview = { datasetId, pending: r.pending || [], levels: r.levels || {}, policy: r.policy || {} };
}

/** Decide, then repaint everything that shows the column's sensitivity. */
async function pvDecide(column: string, level: string): Promise<void> {
  if (!currentProjectId || !expId) return;
  const ds = expId;
  let r: any = null;
  try { r = await window.hubPrivacy.decide(currentProjectId, ds, column, level); } catch (_) { r = null; }
  if (!r || !r.ok) { showToast('Could not save that.'); return; }
  showToast(level === 'none' ? `“${column}” won’t be flagged again` : `“${column}” marked ${level}`);
  if (typeof ctLoadColumnDocs === 'function') await ctLoadColumnDocs(ds, true); // the catalog's own cache
  await pvLoadReview(ds);
  pvPaintBannerNow();
  if (dsProfileCol >= 0 && expColumns[dsProfileCol]) pvPaintProfileNow(expColumns[dsProfileCol].name);
}

function pvDecideButtons(p: any, host: HTMLElement): void {
  const other = p.level === 'personal' ? 'financial' : 'personal';
  host.appendChild(pvBtn('btn btn-sm btn-primary', `Mark as ${p.level}`, () => void pvDecide(p.column, p.level)));
  host.appendChild(pvBtn('btn btn-sm', `Mark as ${other}`, () => void pvDecide(p.column, other)));
  host.appendChild(pvBtn('btn btn-sm pv-quiet', 'Not sensitive', () => void pvDecide(p.column, 'none')));
}

/** Called when a dataset page opens (dsExplorer.openSavedDataset). */
async function pvPaintBanner(datasetId: string): Promise<void> {
  pvBannerOpen = false;
  const host = document.getElementById('pv-review-banner');
  if (host) host.hidden = true;
  await pvLoadReview(datasetId);
  pvPaintBannerNow();
}

function pvPaintBannerNow(): void {
  const host = document.getElementById('pv-review-banner');
  if (!host) return;
  host.innerHTML = '';
  const pending = pvReview && pvReview.datasetId === expId ? pvReview.pending : [];
  host.hidden = pending.length === 0;
  if (!pending.length) return;

  const head = pvEl('div', 'pv-banner-head');
  head.appendChild(icon('shield', 16));
  const n = pending.length;
  const text = pvEl('div', 'pv-banner-text');
  text.appendChild(pvEl('strong', '', `${n} column${n === 1 ? '' : 's'} look${n === 1 ? 's' : ''} sensitive`));
  text.appendChild(pvEl('span', 'pv-banner-cols', ' — ' + pending.map((p) => p.column).join(', ')));
  head.appendChild(text);
  const toggle = pvBtn('btn btn-sm', pvBannerOpen ? 'Done' : 'Review', () => { pvBannerOpen = !pvBannerOpen; pvPaintBannerNow(); });
  toggle.setAttribute('aria-expanded', String(pvBannerOpen));
  head.appendChild(toggle);
  host.appendChild(head);
  if (!pvBannerOpen) return;

  const list = pvEl('div', 'pv-review-list');
  for (const p of pending) {
    const row = pvEl('div', 'pv-review-row');
    const ident = pvEl('div', 'pv-review-ident');
    const name = pvBtn('pv-link pv-review-col', p.column, () => {
      const i = expColumns.findIndex((c) => c.name === p.column);
      if (i >= 0 && dsProfileCol !== i) void dsOpenProfile(i);
    });
    name.title = 'Open the column profile';
    ident.appendChild(name);
    ident.appendChild(pvEl('span', 'pv-level pv-level--' + p.level, PV_LEVEL_LABEL[p.level] + '?')); // a proposal, not a mark
    ident.appendChild(pvEl('div', 'pv-review-reason', `${pvProposalTitle(p)}. ${p.reason}`));
    row.appendChild(ident);
    const acts = pvEl('div', 'pv-review-acts');
    pvDecideButtons(p, acts);
    row.appendChild(acts);
    list.appendChild(row);
  }
  list.appendChild(pvEl('p', 'pv-review-foot', 'Nothing is marked until you choose. Marked columns are masked or left out of exports by this project’s share policy.'));
  host.appendChild(list);
}

/** Called when the column profile opens on `column` (dsProfile.dsOpenProfile). */
async function pvPaintProfile(column: string): Promise<void> {
  if (!pvReview || pvReview.datasetId !== expId) await pvLoadReview(expId);
  pvPaintProfileNow(column);
}

function pvPaintProfileNow(column: string): void {
  const host = document.querySelector('#ds-profile .js-dsp-privacy') as HTMLElement | null;
  if (!host) return;
  host.innerHTML = '';
  host.hidden = true;
  if (!pvReview || pvReview.datasetId !== expId) return;
  const p = pvReview.pending.find((x) => x.column === column);
  if (p) {
    host.className = 'dsp-privacy js-dsp-privacy is-pending';
    const head = pvEl('div', 'pv-prof-head');
    head.appendChild(icon('shield', 14));
    head.appendChild(pvEl('span', '', pvProposalTitle(p)));
    host.appendChild(head);
    host.appendChild(pvEl('p', 'pv-prof-reason', p.reason));
    const acts = pvEl('div', 'pv-prof-acts');
    pvDecideButtons(p, acts);
    host.appendChild(acts);
    host.hidden = false;
    return;
  }
  const level = pvReview.levels[column];
  if (level !== 'personal' && level !== 'financial') return;
  host.className = 'dsp-privacy js-dsp-privacy is-marked';
  const head = pvEl('div', 'pv-prof-head');
  head.appendChild(icon('shield', 14));
  head.appendChild(pvEl('span', 'pv-level pv-level--' + level, PV_LEVEL_LABEL[level] + ' data'));
  host.appendChild(head);
  const masked = (expSteps || []).some((s: any) => s && typeof s.type === 'string' && s.type.startsWith('mask_') && s.column === column);
  const action = pvReview.policy ? pvReview.policy.export : 'mask';
  host.appendChild(pvEl('p', 'pv-prof-reason', masked
    ? 'Masked by a Prepare step — the values here are already tokens or generalised.'
    : PV_ACTION_SENTENCE[action] || PV_ACTION_SENTENCE.mask));
  const acts = pvEl('div', 'pv-prof-acts');
  if (!masked) acts.appendChild(pvBtn('btn btn-sm', 'Mask in Prepare…', () => pvOpenMaskEditor(column)));
  const policy = pvBtn('pv-link', 'Share policy', () => void showSettingsPanel('privacy'));
  acts.appendChild(policy);
  host.appendChild(acts);
  host.hidden = false;
}
