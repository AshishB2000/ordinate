'use strict';

// Settings → Automation. Classic global-scope renderer <script>: no
// import/export. Builds into #stp-automation (index.html) with the panel's own
// row helpers (settingsFormats.ts sfEl / sfRow).
//
// Everything painted comes from main (`automation:status`); every switch
// writes through main (`automation:set`) and repaints from its answer, so the
// pane never shows a state the server is not in.
//
// THE TOKEN is taken from main at most once per issue (`automation:takeToken`
// hands it out a single time), and only while this pane is on screen. It stays
// visible until the pane is left, then only the mask remains — there is no way
// back to it except Regenerate.

let amStatus: any = null;
let amFreshToken = '';
let amPortDraft = '';
let amBusy = false;

function amSwitch(id: string, label: string, on: boolean, onToggle: () => void): HTMLButtonElement {
  const b = sfEl<HTMLButtonElement>('button', 'stp-switch' + (on ? ' stp-switch-on' : ''));
  b.id = id;
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', on ? 'true' : 'false');
  b.setAttribute('aria-label', label);
  b.appendChild(sfEl('span', 'stp-switch-thumb'));
  b.addEventListener('click', onToggle);
  return b;
}

function amCopyButton(text: () => string, label = 'Copy'): HTMLButtonElement {
  const b = sfEl<HTMLButtonElement>('button', 'btn btn-sm am-copy');
  b.type = 'button';
  b.append(icon('copy', 14), document.createTextNode(label));
  b.addEventListener('click', () => {
    window.hub.copyText(text());
    b.classList.add('is-done');
    b.lastChild!.textContent = 'Copied';
    setTimeout(() => { b.classList.remove('is-done'); b.lastChild!.textContent = label; }, 1600);
  });
  return b;
}

/** A command the user pastes somewhere: monospace, selectable, one Copy. */
function amCode(text: string, id?: string): HTMLElement {
  const box = sfEl('div', 'am-code');
  const pre = sfEl('code', 'am-code-text', text);
  if (id) pre.id = id;
  box.append(pre, amCopyButton(() => text));
  return box;
}

function amSubhead(title: string, desc?: string): HTMLElement {
  const h = sfEl('div', 'stp-subhead');
  h.appendChild(sfEl('div', 'stp-subhead-t', title));
  if (desc) h.appendChild(sfEl('div', 'stp-subhead-d', desc));
  return h;
}

async function amSet(patch: { enabled?: boolean; http?: boolean; port?: number }): Promise<void> {
  if (amBusy) return;
  amBusy = true;
  try {
    const res = await window.hubAutomation.set(patch);
    if (res && res.ok === false && res.message) showToast(res.message, { kind: 'error' });
    amStatus = res;
    if (patch.port !== undefined && res && res.ok !== false) amPortDraft = '';
    await amTakeToken();
  } finally {
    amBusy = false;
  }
  amPaint();
}

/** Take a freshly issued token — only while the pane is visible, so it is SEEN once. */
async function amTakeToken(): Promise<void> {
  const pane = document.getElementById('stp-automation');
  if (!pane || !pane.offsetParent || !amStatus || !amStatus.token || !amStatus.token.fresh) return;
  const res = await window.hubAutomation.takeToken();
  if (res && res.token) amFreshToken = res.token;
}

function amTokenRow(): HTMLElement {
  const s = amStatus;
  if (amFreshToken) {
    const box = sfEl('div', 'am-token am-token-fresh');
    const code = sfEl('code', 'am-token-value', amFreshToken);
    code.id = 'am-token-value';
    box.append(code, amCopyButton(() => amFreshToken));
    const wrap = sfEl('div', 'am-token-wrap');
    wrap.append(box, sfEl('div', 'am-note am-note-warn',
      'Shown once. Copy it now — it is kept in memory only and changes every time Ordinate starts.'));
    return sfRow('Access token', 'Tools send it as a Bearer token.', wrap);
  }
  const masked = sfEl('code', 'am-token-value am-token-masked', s.token.exists ? s.token.masked : 'Not issued yet');
  masked.id = 'am-token-value';
  const regen = sfEl<HTMLButtonElement>('button', 'btn btn-sm', 'Regenerate');
  regen.type = 'button';
  regen.id = 'am-token-regen';
  regen.disabled = !s.running;
  regen.addEventListener('click', async () => {
    amStatus = await window.hubAutomation.regenerateToken();
    await amTakeToken();
    amPaint();
  });
  return sfRow('Access token',
    'Hidden after it was shown. Regenerate for a new one — tools using the old token stop working at once.',
    masked, regen);
}

function amHttpSection(host: HTMLElement): void {
  const s = amStatus;
  host.appendChild(amSubhead('Local HTTP server',
    'For tools that connect by URL instead of starting Ordinate themselves. It listens on this computer only (127.0.0.1) and every request needs the access token.'));
  const group = sfEl('div', 'stp-group');
  group.appendChild(sfRow('Serve over HTTP', 'A second switch, off by default.',
    amSwitch('am-http', 'Serve MCP over local HTTP', s.http, () => void amSet({ http: !s.http }))));
  if (s.http) {
    const pill = sfEl('span', 'am-pill ' + (s.running ? 'is-on' : s.error ? 'is-err' : 'is-off'));
    pill.id = 'am-http-state';
    pill.appendChild(sfEl('span', 'am-dot'));
    pill.appendChild(document.createTextNode(s.running ? 'Listening' : s.error ? 'Not running' : 'Stopped'));
    const port = sfEl<HTMLInputElement>('input', 'stp-input am-port');
    port.id = 'am-port';
    port.type = 'number';
    port.min = '1024';
    port.max = '65535';
    port.value = amPortDraft || String(s.port);
    port.setAttribute('aria-label', 'Port');
    const apply = sfEl<HTMLButtonElement>('button', 'btn btn-sm', 'Apply');
    apply.type = 'button';
    apply.id = 'am-port-apply';
    apply.hidden = !amPortDraft || amPortDraft === String(s.port);
    port.addEventListener('input', () => { amPortDraft = port.value; apply.hidden = !port.value || port.value === String(s.port); });
    port.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply.click(); });
    apply.addEventListener('click', () => void amSet({ port: Number(port.value) }));
    const where = s.error ? s.error : s.running ? s.url : 'Starts when you apply a free port.';
    group.appendChild(sfRow('Address', where, pill, port, apply));
    group.appendChild(amTokenRow());
  }
  host.appendChild(group);
  if (s.http && s.running) {
    host.appendChild(sfEl('div', 'am-note', 'To add it to Claude Code by URL, run this with <token> replaced by the access token:'));
    host.appendChild(amCode(s.httpSetup));
  }
}

function amToolsSection(host: HTMLElement): void {
  const tools: any[] = Array.isArray(amStatus.tools) ? amStatus.tools : [];
  host.appendChild(amSubhead('What a connected tool can do',
    'Every figure is computed by Ordinate. Connections, keys and settings are never exposed.'));
  const box = sfEl('div', 'am-tools');
  const group = (title: string, hint: string, list: any[], kind: string): HTMLElement => {
    const g = sfEl('div', 'am-tools-group am-tools-' + kind);
    const head = sfEl('div', 'am-tools-head');
    head.append(icon(kind === 'read' ? 'eye' : 'plus', 14), sfEl('span', 'am-tools-title', title), sfEl('span', 'am-tools-hint', hint));
    const chips = sfEl('div', 'am-tools-chips');
    for (const t of list) {
      const chip = sfEl('code', 'am-chip', t.name);
      chip.title = t.summary; // the registry's own one-liner
      chips.appendChild(chip);
    }
    g.append(head, chips);
    return g;
  };
  box.append(
    group('Read', 'Look, compute and export — nothing in the workspace changes.', tools.filter((t) => t.readOnly), 'read'),
    group('Create', 'Save a new visual or dashboard. Never changes data; each one is listed in Jobs.', tools.filter((t) => !t.readOnly), 'write'),
  );
  host.appendChild(box);
}

function amPaint(): void {
  const host = document.getElementById('stp-automation');
  if (!host || !amStatus) return;
  const s = amStatus;
  host.textContent = '';

  const master = sfEl('div', 'stp-group');
  master.appendChild(sfRow('Allow tools to connect',
    'Runs a local MCP server, so a tool like Claude Code can read your datasets and metrics and draft visuals and dashboards. It can never change your data.',
    amSwitch('am-enabled', 'Allow tools like Claude Code to connect', s.enabled, () => void amSet({ enabled: !s.enabled }))));
  host.appendChild(master);

  if (!s.enabled) {
    const off = sfEl('div', 'am-off');
    off.id = 'am-off';
    const ic = sfEl('div', 'am-off-ic');
    ic.appendChild(icon('shield', 20));
    const text = sfEl('div', 'am-off-text');
    text.append(sfEl('div', 'am-off-t', 'No tool can connect'),
      sfEl('div', 'am-off-d', 'The MCP server is off, so nothing outside this window can reach your workspace. Turn it on when you want a tool like Claude Code to work with your data.'));
    off.append(ic, text);
    host.appendChild(off);
  } else {
    host.appendChild(amSubhead('Connect Claude Code',
      'Claude Code starts Ordinate in the background and talks to it over stdio — no port, no token. Run this once in a terminal:'));
    host.appendChild(amCode(s.stdioSetup, 'am-stdio-cmd'));
    amHttpSection(host);
    amToolsSection(host);
  }

  host.appendChild(amSubhead('Command line',
    'Script Ordinate from any terminal. Always available — it runs as you, on your own files, whether or not the switch above is on.'));
  host.appendChild(amCode(s.cliExample, 'am-cli-cmd'));
  host.appendChild(sfEl('div', 'am-note', 'Add --cli help for every command, --json for machine output. Exit codes: 0 ok, 1 error, 2 usage, 3 not found.'));
}

async function amRefresh(): Promise<void> {
  try {
    amStatus = await window.hubAutomation.status();
    await amTakeToken();
  } catch (_) {
    return;
  }
  amPaint();
}

(function initSettingsAutomation(): void {
  const host = document.getElementById('stp-automation');
  const pane = host && host.closest('.settings-pane');
  if (!host || !pane || !window.hubAutomation) return;
  // The pane is on screen when its category is selected (selectSettingsCat
  // flips `hidden`) AND the Settings panel is open (its inline display).
  // Arriving is the moment to read the state; leaving is when a shown token goes.
  let shown = false;
  const sync = (): void => {
    const now = !!(host as HTMLElement).offsetParent;
    if (now === shown) return;
    shown = now;
    if (now) { void amRefresh(); return; }
    amFreshToken = '';
    amPortDraft = '';
    if (amStatus) amPaint();
  };
  const watch = new MutationObserver(sync);
  watch.observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  const panel = document.getElementById('settings-panel');
  if (panel) watch.observe(panel, { attributes: true, attributeFilter: ['style'] });
})();
