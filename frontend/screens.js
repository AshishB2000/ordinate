/* ============================================================
   Screenchart — screen templates. Each returns the INNER html
   of a .window (titlebar + body). Theme-agnostic: all colors
   come from CSS tokens, so the same markup renders in light
   and dark. Mounted twice by build.js.
   ============================================================ */

/* ---------- shared chrome ---------- */
function titlebar(sub, opts={}){
  const ctrls = opts.ctrls===false ? '' :
    `<div class="tb-ctrls">${ic('search',13,1.8)}${ic('chevd',13,1.8)}</div>`;
  return `<div class="titlebar">
    <div class="tb-mark">${icFill('spark',11)}</div>
    <div class="tb-title">Screenchart</div>
    ${sub?`<div class="tb-sub">— ${sub}</div>`:''}
    <div class="tb-spacer"></div>
    ${ctrls}
  </div>`;
}

/* ---------- history data + sidebar ---------- */
const HISTORY = [
  { thumb: thumbTable,  sum:'West leads every quarter; total up 31% to $661K', time:'2m',  kind:'Table → chart' },
  { thumb: thumbLine,   sum:'MAU up 2.5× over the year; Aug dip looks seasonal', time:'1h', kind:'Chart' },
  { thumb: thumbFunnel, sum:'Biggest drop-off is at the checkout step (−38%)', time:'3h', kind:'Chart' },
  { thumb: thumbBars,   sum:'Hardware carries the lowest margin at 22%', time:'Yesterday', kind:'Table → chart' },
  { thumb: thumbArea,   sum:'Support tickets down 18% week over week', time:'Yesterday', kind:'Chart' },
  { thumb: thumbBars,   sum:'EU signups overtook US in March', time:'Mon', kind:'Table → chart' },
];

function sidebar(selected, empty=false){
  const newBtn = `<button class="btn btn-primary btn-block">${ic('plus',15,2)}New capture</button>
    <div class="side-search">${ic('search',13,1.8)}<span>Search captures</span></div>`;
  let list;
  if(empty){
    list = `<div class="history" style="align-items:center;justify-content:center;text-align:center;padding:24px 18px;gap:10px;">
      <div style="width:34px;height:34px;border-radius:9px;background:var(--surface-2);display:grid;place-items:center;color:var(--faint);">${ic('clock',17,1.7)}</div>
      <div style="font-size:12.5px;color:var(--muted);font-weight:600;">No captures yet</div>
      <div style="font-size:11.5px;color:var(--faint);line-height:1.5;">Your analyzed charts and tables will show up here.</div>
    </div>`;
  } else {
    list = `<div class="side-label">Recent</div><div class="history">` + HISTORY.map((h,i)=>`
      <div class="hist-item${i===selected?' selected':''}">
        <span class="hist-thumb">${h.thumb()}</span>
        <div class="hist-meta">
          <p class="hist-summary">${h.sum}</p>
          <div class="hist-time">${ic('clock',11,1.7)} ${h.time} · ${h.kind}</div>
        </div>
      </div>`).join('') + `</div>`;
  }
  return `<aside class="sidebar">
    <div class="side-top">${newBtn}</div>
    ${list}
    <div class="side-bottom">
      <div class="side-gear">${ic('gear',16,1.6)} Settings</div>
      <div class="api-chip"><span class="dot" style="background:currentColor"></span> Key OK</div>
    </div>
  </aside>`;
}

/* ---------- main toolbar ---------- */
function mainTop(title, sub){
  return `<div class="main-top">
    <div class="main-title">
      <h2>${title}</h2>
      ${sub?`<p>${sub}</p>`:''}
    </div>
    <div class="tb-spacer"></div>
    <div class="hotkey-hint"><span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">S</span></div>
    <button class="btn btn-primary">${ic('camera',16,1.7)}Take screenshot</button>
  </div>`;
}

/* ---------- chat bar ---------- */
function chatBar(chips, ph='Ask a follow-up…'){
  const cs = (chips||[]).map(c=>`<span class="chip">${c}</span>`).join('');
  return `<div class="chat-bar">
    ${cs?`<div class="suggest-chips">${cs}</div>`:''}
    <div class="chat-input">
      <span class="attach">${ic('clip',16,1.7)}</span>
      <span class="ph">${ph}</span>
      <span class="chat-send" style="color:#fff">${ic('send',15,1.9)}</span>
    </div>
  </div>`;
}

/* ---------- the extracted-numbers table ---------- */
function extractedTable(){
  const rows = REGION.rows.map(r=>`<tr>
    <td><span class="swatch" style="background:${r.color}"></span>${r.name}</td>
    ${r.v.map(v=>`<td>${v}</td>`).join('')}
  </tr>`).join('');
  return `<table class="xtable">
    <thead><tr><th>Region</th>${REGION.cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ---------- analysis avatar head ---------- */
function anHead(tag){
  return `<div class="an-head">
    <div class="an-avatar" style="color:#fff">${icFill('spark',13)}</div>
    <span class="nm">Analysis</span>
    ${tag?`<span class="tag tag-blue">${tag}</span>`:''}
  </div>`;
}

/* ============================================================
   1 · HUB — TABLE RESULT  (the differentiator)
   ============================================================ */
function hubTableResult(){
  return titlebar() + `<div class="hub-body">
    ${sidebar(0)}
    <section class="main">
      ${mainTop('Quarterly Revenue by Region', 'Table capture · extracted &amp; charted')}
      <div class="conv">
        <div class="cap-wrap">
          <div class="cap-head">${ic('table',15,1.7)}<span class="ttl">Your capture</span><span class="tag tag-muted">Table</span></div>
          <div class="capture shot-frame">${mockSpreadsheet()}</div>
        </div>
        <div class="analysis">
          ${anHead('Table → chart')}
          <div class="an-body">
            <div class="result-cols">
              <div class="rc-card">
                <div class="rc-head"><span class="lbl">Extracted numbers</span><span class="meta">16 values</span></div>
                <div class="rc-inner">${extractedTable()}</div>
              </div>
              <div class="rc-card">
                <div class="rc-head"><span class="lbl">Generated chart</span><span class="meta">Grouped bar</span></div>
                <div class="rc-inner">
                  ${barChartThemed(360,210)}
                  <div class="chart-legend">
                    ${REGION.rows.map(r=>`<span class="lg"><i style="background:${r.color}"></i>${r.name}</span>`).join('')}
                  </div>
                </div>
              </div>
            </div>
            <div class="verify-note">${ic('check',14,2)}<span>Numbers read straight from your screenshot — compare them against the cells above to catch any misread digit.</span></div>
            <p style="margin-top:14px"><strong>West</strong> leads every quarter, reaching <em>$210K</em> in Q4. <strong>South</strong> grew the fastest over the year (<em>+41%</em>), while <strong>East</strong> stays the smallest region but adds roughly $10K each quarter — the steadiest line in the set.</p>
            <p>Total revenue rose from <strong>$503K</strong> in Q1 to <strong>$661K</strong> in Q4, up <em>31%</em>.</p>
          </div>
        </div>
      </div>
      ${chatBar(['Redraw as a line chart','Explain Q3','Which region is at risk?'])}
    </section>
  </div>`;
}

/* ============================================================
   1b · HUB — CHART RESULT (screenshot + plain-English)
   ============================================================ */
function hubChartResult(){
  return titlebar() + `<div class="hub-body">
    ${sidebar(1)}
    <section class="main">
      ${mainTop('Monthly Active Users', 'Chart capture · explained in plain English')}
      <div class="conv">
        <div class="cap-wrap">
          <div class="cap-head">${ic('line',15,1.7)}<span class="ttl">Your capture</span><span class="tag tag-muted">Chart</span></div>
          <div class="capture shot-frame">${mockDashboard()}</div>
        </div>
        <div class="analysis">
          ${anHead('Chart explained')}
          <div class="an-body">
            <p>This line chart tracks <strong>monthly active users</strong> across the year. Usage climbed steadily from <strong>12K</strong> in January to <strong>31K</strong> in December — roughly <em>2.5× growth</em>.</p>
            <p>The dip to <strong>21K</strong> in August breaks the trend, but it lines up with a typical summer slowdown rather than churn: growth resumes immediately in September. The steepest gains came in <strong>Q2 (May–June)</strong>, when the line is at its sharpest.</p>
            <p style="color:var(--muted)">Watch September–October — if growth flattens there, the autumn momentum may be cooling.</p>
          </div>
        </div>
      </div>
      ${chatBar(['Explain the August dip','What’s driving Q2?','Turn this into a table'])}
    </section>
  </div>`;
}

/* ============================================================
   1c · HUB — EMPTY STATE
   ============================================================ */
function hubEmpty(){
  const step=(n,t)=>`<div class="step"><div class="step-n">${n}</div><div class="step-t">${t}</div></div>`;
  return titlebar() + `<div class="hub-body">
    ${sidebar(-1,true)}
    <section class="main">
      ${mainTop('Welcome', 'Capture a chart or table to begin')}
      <div class="conv" style="padding:0">
        <div class="state-pad">
          <div class="state-narrow">
            <div class="empty-mark">${ic('camera',26,1.6)}</div>
            <h1 class="empty-h">Turn any chart into an answer</h1>
            <p class="empty-sub">Screenshot a chart and get it explained in plain English — or capture a table and watch Screenchart read the numbers and chart them for you.</p>
            <div class="steps">
              ${step(1,'Press <span class="kbd">⌘</span> <span class="kbd">⇧</span> <span class="kbd">S</span> or click <strong>Take screenshot</strong>.')}
              ${step(2,'Drag a box around a <strong>chart or table</strong> on your screen.')}
              ${step(3,'Get a plain-English read — <span class="mut">numbers, trends, and the takeaway</span>.')}
            </div>
            <button class="btn btn-primary btn-lg btn-block" style="margin-bottom:16px">${ic('camera',16,1.7)}Take screenshot</button>
            <div class="api-banner">
              ${ic('key',16,1.8)}
              <span class="tx">Add your AI API key to start analyzing.</span>
              <a class="lk">Open Settings</a>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>`;
}

/* ============================================================
   1d · HUB — LOADING STATE
   ============================================================ */
function hubLoading(){
  const ls=(cls,icn,t)=>`<div class="load-step ${cls}"><span class="ck">${icn}</span>${t}</div>`;
  return titlebar() + `<div class="hub-body">
    ${sidebar(0)}
    <section class="main">
      ${mainTop('Quarterly Revenue by Region', 'Analyzing your capture…')}
      <div class="conv">
        <div class="cap-wrap" style="opacity:.7">
          <div class="cap-head">${ic('table',15,1.7)}<span class="ttl">Your capture</span><span class="tag tag-muted">Table</span></div>
          <div class="capture shot-frame">${mockSpreadsheet()}</div>
        </div>
        <div class="analysis">
          ${anHead('')}
          <div class="state-pad" style="padding:8px 0 4px;align-items:flex-start">
            <div style="display:flex;gap:14px;align-items:center;width:100%">
              <div class="spinner anim-spin"></div>
              <div style="text-align:left">
                <div class="load-h">Reading your capture…</div>
                <div class="load-sub">Extracting the numbers and drawing your chart. This usually takes a few seconds.</div>
              </div>
            </div>
            <div class="load-steps" style="width:100%">
              ${ls('','&#10003;','Detected a table (4 regions × 4 quarters)')}
              ${ls('now',ic('spinner',12,2)+'','Reading 16 values')}
              ${ls('todo','','Drawing grouped bar chart')}
              ${ls('todo','','Writing the analysis')}
            </div>
          </div>
        </div>
      </div>
      <div class="chat-bar"><div class="chat-input" style="opacity:.55"><span class="attach">${ic('clip',16,1.7)}</span><span class="ph">Ask a follow-up…</span><span class="chat-send" style="background:var(--surface-3);color:var(--faint)">${ic('send',15,1.9)}</span></div></div>
    </section>
  </div>`;
}

/* ============================================================
   1e · HUB — ERROR STATE (invalid key)
   ============================================================ */
function hubError(){
  return titlebar() + `<div class="hub-body">
    ${sidebar(0)}
    <section class="main">
      ${mainTop('Quarterly Revenue by Region', 'Couldn’t complete the analysis')}
      <div class="conv">
        <div class="cap-wrap" style="opacity:.7">
          <div class="cap-head">${ic('table',15,1.7)}<span class="ttl">Your capture</span><span class="tag tag-muted">Table</span></div>
          <div class="capture shot-frame">${mockSpreadsheet()}</div>
        </div>
        <div class="analysis">
          <div class="state-pad" style="padding:10px 0">
            <div class="state-narrow">
              <div class="err-mark">${ic('key',24,1.7)}</div>
              <h3 class="err-h">Your API key was rejected</h3>
              <p class="err-sub">The provider didn’t accept this key. It may be expired, revoked, or copied incompletely. Your capture is saved — fix the key and try again.</p>
              <div class="err-detail">${ic('alert',13,1.8)} Anthropic API · <span class="err-code">401 · invalid_api_key</span></div>
              <div class="err-actions">
                <button class="btn btn-primary">${ic('gear',15,1.7)}Open Settings</button>
                <button class="btn btn-soft">${ic('refresh',15,1.8)}Retry</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="chat-bar"><div class="chat-input" style="opacity:.55"><span class="attach">${ic('clip',16,1.7)}</span><span class="ph">Ask a follow-up…</span><span class="chat-send" style="background:var(--surface-3);color:var(--faint)">${ic('send',15,1.9)}</span></div></div>
    </section>
  </div>`;
}

/* ============================================================
   3 · FIRST-RUN / API KEY SETUP
   ============================================================ */
const PROVIDERS = [
  { nm:'Claude',     logo:'C', c:'#D97757', sel:true },
  { nm:'OpenAI',     logo:'O', c:'#10A37F' },
  { nm:'Gemini',     logo:'G', c:'#4285F4' },
  { nm:'OpenRouter', logo:'R', c:'#6366F1' },
  { nm:'Custom',     logo:'+', c:'#6B7280' },
];
function setupScreen(){
  const provs = PROVIDERS.map(p=>`<div class="prov${p.sel?' selected':''}">
    <div class="prov-logo" style="background:${p.c}">${p.logo}</div>
    <div class="prov-nm">${p.nm}</div>
    ${p.sel?`<span class="prov-check" style="color:var(--accent)">${ic('check',15,2.2)}</span>`:''}
  </div>`).join('');
  return titlebar('Setup', {ctrls:false}) + `<div class="form-body" style="gap:0">
    <div style="margin-bottom:20px">
      <div class="empty-mark" style="margin:0 0 14px;width:46px;height:46px;border-radius:13px">${ic('key',22,1.7)}</div>
      <h1 class="empty-h" style="font-size:19px">Connect your AI</h1>
      <p class="empty-sub" style="margin-bottom:0;font-size:13px">Screenchart runs on your own API key, so your data goes straight to the provider you trust — never through us.</p>
    </div>
    <div class="form-scroll">
      <div class="field">
        <label>Choose a provider</label>
        <div class="provider-grid">${provs}</div>
      </div>
      <div class="field">
        <label>API key</label>
        <div class="input mono focus"><span class="val">sk-ant-••••••••••••••••••••••••</span><span class="ic">${ic('eye',15,1.7)}</span></div>
        <span class="hint">${ic('lock',12,1.7)} Stored locally on this device — encrypted in your OS keychain.</span>
      </div>
      <div style="display:flex;align-items:center;gap:9px">
        <button class="btn btn-soft btn-sm">${ic('check',14,2)}Validate key</button>
        <span class="tag tag-ok">${ic('check',12,2.4)} Valid · Claude 3.5 Sonnet</span>
      </div>
    </div>
  </div>
  <div class="form-foot">
    <a class="lk" style="font-size:12.5px;display:inline-flex;align-items:center;gap:6px">Get an API key ${ic('ext',13,1.8)}</a>
    <button class="btn btn-primary">Continue ${ic('arrowr',15,1.8)}</button>
  </div>`;
}

/* ============================================================
   6 · SETTINGS
   ============================================================ */
function settingsRow(t,d,control){
  return `<div class="set-row"><div class="rl"><div class="t">${t}</div>${d?`<div class="d">${d}</div>`:''}</div><div class="rr">${control}</div></div>`;
}
function settingsScreen(){
  const grp=(t,rows)=>`<div style="margin-bottom:6px"><div class="side-label" style="padding:6px 0">${t}</div>${rows}</div>`;
  const select=(v)=>`<div class="select" style="min-width:190px"><span>${v}</span>${ic('chevd',15,1.8)}</div>`;
  const themeSeg = `<div class="seg theme-aware">
      <span class="opt" data-opt="light">Light</span>
      <span class="opt" data-opt="dark">Dark</span>
    </div>`;
  return titlebar('Settings', {ctrls:false}) + `<div class="form-body">
    <div class="form-scroll scrollhint" style="overflow:hidden">
      ${grp('AI Provider', settingsRow('Provider','Which model service to send captures to', select('Claude'))
        + settingsRow('API key','Encrypted in your OS keychain', `<div style="display:flex;gap:8px;align-items:center"><div class="input mono" style="width:210px"><span class="val">sk-ant-••••••••••••</span><span class="ic">${ic('eye',14,1.7)}</span></div><span class="tag tag-ok">${ic('check',12,2.4)} Valid</span></div>`)
        + settingsRow('Model','', select('Claude 3.5 Sonnet'))
        + settingsRow('Custom endpoint','Only used for self-hosted or proxy setups', `<div class="input" style="width:210px"><span class="ph">https://api.example.com/v1</span></div>`)
      )}
      ${grp('Capture', settingsRow('Global hotkey','Trigger a capture from anywhere', `<div style="display:flex;gap:8px;align-items:center"><span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">S</span><button class="btn btn-soft btn-sm">Change</button></div>`)
        + `<div class="set-row" style="align-items:flex-start"><div class="rl"><div class="t">Default prompt</div><div class="d">Sent with every capture. Tune the tone or detail.</div></div></div>`
        + `<div class="textarea" style="margin:-6px 0 4px">Explain this chart in plain English for a non-technical teammate. If it’s a table, read out the numbers, pick the clearest chart, and end with the single most important takeaway.</div>`
      )}
      ${grp('Appearance', settingsRow('Theme','Light, or dark for low-light rooms', themeSeg)
        + settingsRow('Launch at login','Start Screenchart when you sign in', `<div class="switch on"><i></i></div>`)
      )}
    </div>
  </div>
  <div class="form-foot"><span class="faint" style="font-size:12px">Screenchart 1.0.0</span><button class="btn btn-primary">Done</button></div>`;
}

/* ============================================================
   7 · ABOUT / HELP
   ============================================================ */
function aboutScreen(){
  const link=(t,i)=>`<span class="chip">${ic(i,13,1.7)} ${t}</span>`;
  const trouble=(t,d)=>`<div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--border-2)"><span style="color:var(--faint);margin-top:1px">${ic('info',15,1.7)}</span><div><div style="font-size:12.5px;font-weight:600">${t}</div><div style="font-size:12px;color:var(--muted);margin-top:1px">${d}</div></div></div>`;
  return titlebar('About', {ctrls:false}) + `<div class="form-body" style="text-align:center;align-items:center">
    <div class="tb-mark" style="width:54px;height:54px;border-radius:15px;margin:6px auto 14px">${icFill('spark',26)}</div>
    <h1 class="empty-h" style="font-size:20px;margin-bottom:4px">Screenchart</h1>
    <div class="faint" style="font-size:12.5px;margin-bottom:12px">Version 1.0.0</div>
    <p class="muted" style="font-size:13px;max-width:320px;line-height:1.55;margin:0 auto 18px">Screenshot any chart or table and get a clear, plain-English read — powered by your own AI key.</p>
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:22px">${link('Website','ext')}${link('Privacy','shield')}${link('Support','msg')}</div>
    <div style="text-align:left;width:100%;max-width:360px">
      <div class="side-label" style="padding:0 0 4px">Troubleshooting</div>
      ${trouble('Capture comes back black','Grant Screen Recording permission in System Settings.')}
      ${trouble('“Key was rejected”','Re-paste your API key under Settings → AI Provider.')}
      ${trouble('A number looks wrong','Re-capture tighter around the table so text stays crisp.')}
    </div>
    <div class="tb-spacer"></div>
    <div class="faint" style="font-size:11.5px;margin-top:18px">Made for people who live in dashboards and spreadsheets.</div>
  </div>`;
}

/* ============================================================
   8 · macOS PERMISSION
   ============================================================ */
function permissionScreen(){
  const step=(n,t)=>`<div class="step"><div class="step-n">${n}</div><div class="step-t">${t}</div></div>`;
  return titlebar('Permission', {ctrls:false}) + `<div class="form-body" style="align-items:center;text-align:center">
    <div class="err-mark" style="background:var(--accent-weak);color:var(--accent);width:50px;height:50px;border-radius:14px;margin-bottom:14px">${ic('monitor',24,1.6)}</div>
    <h1 class="empty-h" style="font-size:18px;margin-bottom:6px">Screenchart can’t see your screen</h1>
    <p class="empty-sub" style="font-size:13px;max-width:330px;margin-bottom:20px">Your last capture came back black. macOS needs your permission before Screenchart can read what’s on screen.</p>
    <div class="steps" style="text-align:left;width:100%;max-width:340px;margin-bottom:20px">
      ${step(1,'Open <strong>System Settings → Privacy &amp; Security</strong>.')}
      ${step(2,'Select <strong>Screen &amp; System Audio Recording</strong>.')}
      ${step(3,'Turn on the switch next to <strong>Screenchart</strong>.')}
      ${step(4,'Quit and reopen Screenchart.')}
    </div>
    <div style="display:flex;gap:9px;justify-content:center;width:100%;max-width:340px">
      <button class="btn btn-primary btn-block">${ic('gear',15,1.7)}Open System Settings</button>
      <button class="btn btn-soft">Done</button>
    </div>
  </div>`;
}

/* ============================================================
   5 · QUICK POPUP  (compact floating result)
   ============================================================ */
function popupHead(tag){
  return `<div class="titlebar">
    <div class="tb-mark">${icFill('spark',11)}</div>
    <div class="tb-title">Screenchart</div>
    ${tag?`<span class="tag tag-blue" style="margin-left:2px">${tag}</span>`:''}
    <div class="tb-spacer"></div>
    <span class="tb-ctrls">${ic('xcircle',14,1.7)}</span>
  </div>`;
}
function popupResult(){
  return popupHead('Table → chart') + `<div class="popup-body">
    <div style="display:flex;gap:10px;align-items:center">
      <span class="hist-thumb" style="width:46px;height:34px">${thumbTable()}</span>
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:650;line-height:1.3">West leads every quarter</div>
        <div style="font-size:11.5px;color:var(--muted)">Revenue up 31% to $661K in Q4</div>
      </div>
    </div>
    <div class="rc-card">
      <div class="rc-head"><span class="lbl">Generated chart</span><span class="meta">16 values</span></div>
      <div class="rc-inner" style="padding:8px 10px">${barChartThemed(300,128)}
        <div class="chart-legend" style="margin-top:4px">${REGION.rows.map(r=>`<span class="lg" style="font-size:10.5px"><i style="background:${r.color}"></i>${r.name}</span>`).join('')}</div>
      </div>
    </div>
    <p style="font-size:12px;color:var(--muted);line-height:1.5;margin:0">East is the smallest region but the steadiest — add ~$10K every quarter.</p>
  </div>
  <div class="popup-foot">
    <span class="faint" style="font-size:11.5px;display:inline-flex;align-items:center;gap:5px">${ic('check',13,2)} Saved to hub</span>
    <button class="btn btn-primary btn-sm">${ic('arrowr',14,1.8)}Open in hub</button>
  </div>`;
}
function popupLoading(){
  return popupHead('') + `<div class="popup-body" style="align-items:center;justify-content:center;text-align:center;min-height:230px;gap:14px">
    <div class="spinner anim-spin"></div>
    <div>
      <div class="load-h" style="font-size:14px">Analyzing capture…</div>
      <div class="load-sub" style="font-size:12px">Reading the numbers and drawing your chart.</div>
    </div>
    <div style="display:flex;gap:6px;width:170px;flex-direction:column">
      <div class="shimmer" style="height:9px;width:100%"></div>
      <div class="shimmer" style="height:9px;width:75%"></div>
    </div>
  </div>
  <div class="popup-foot"><span class="faint" style="font-size:11.5px">Hold tight…</span><button class="btn btn-soft btn-sm" style="opacity:.6">Open in hub</button></div>`;
}
function popupError(){
  return popupHead('') + `<div class="popup-body" style="align-items:center;justify-content:center;text-align:center;min-height:230px;gap:12px;padding:18px 16px">
    <div class="err-mark" style="width:44px;height:44px;border-radius:12px">${ic('wifi',22,1.7)}</div>
    <div>
      <div class="err-h" style="font-size:15px">No internet connection</div>
      <p class="err-sub" style="font-size:12.5px;margin:6px 0 0;max-width:240px">Screenchart needs to reach your AI provider. Check your connection — your capture is saved.</p>
    </div>
    <div class="err-detail" style="margin:2px 0 0">${ic('alert',12,1.8)} <span class="err-code">network · ENOTFOUND</span></div>
  </div>
  <div class="popup-foot"><button class="btn btn-soft btn-sm">Open in hub</button><button class="btn btn-primary btn-sm">${ic('refresh',14,1.8)}Retry</button></div>`;
}

/* ============================================================
   4 · CAPTURE OVERLAY
   ============================================================ */
function captureOverlay(){
  return `<div class="ov-desktop" style="background:
      radial-gradient(120% 130% at 78% 8%, #3a4d8a 0%, #2a356b 42%, #1a1f47 100%);">
    <!-- a window on the desktop holding a dashboard the user is capturing -->
    <div style="position:absolute;left:118px;top:96px;width:560px;border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.45);background:#fff;border:1px solid rgba(0,0,0,.2)">
      <div style="height:34px;background:#f3f4f7;border-bottom:1px solid #e7e9ee;display:flex;align-items:center;gap:7px;padding:0 12px">
        <span style="width:9px;height:9px;border-radius:50%;background:#e2e4ea"></span>
        <span style="width:9px;height:9px;border-radius:50%;background:#e2e4ea"></span>
        <span style="width:9px;height:9px;border-radius:50%;background:#e2e4ea"></span>
        <span style="font-size:11.5px;color:#8b90a0;margin-left:8px">Q4 Board — Revenue</span>
      </div>
      ${mockDashboard()}
    </div>
    <!-- a second window peeking -->
    <div style="position:absolute;right:70px;top:300px;width:330px;border-radius:12px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.4);background:#fff;opacity:.96">
      <div style="height:30px;background:#f3f4f7;border-bottom:1px solid #e7e9ee;display:flex;align-items:center;padding:0 12px;font-size:11px;color:#8b90a0">Notes</div>
      <div style="padding:14px;font-size:12px;color:#aeb2bd;line-height:1.7">— share with finance<br>— flag the Aug dip<br>— ask about EU split</div>
    </div>
  </div>
  <!-- the drag selection: box-shadow creates the dimmed surround -->
  <div class="ov-sel" style="left:132px;top:212px;width:300px;height:196px;box-shadow:0 0 0 9999px rgba(10,12,22,0.6)">
    <div class="ov-handle" style="left:-4.5px;top:-4.5px"></div>
    <div class="ov-handle" style="right:-4.5px;top:-4.5px"></div>
    <div class="ov-handle" style="left:-4.5px;bottom:-4.5px"></div>
    <div class="ov-handle" style="right:-4.5px;bottom:-4.5px"></div>
  </div>
  <div class="ov-dims" style="left:132px;top:182px">300 × 196</div>
  <div class="ov-toolbar" style="left:132px;top:420px">
    <div class="seg2">
      <span class="ob on">${ic('line',14,1.8)}Explain</span>
      <span class="ob">${ic('bars',14,1.8)}Table → chart</span>
    </div>
    <span style="width:1px;height:20px;background:rgba(255,255,255,.14)"></span>
    <span class="ob" style="color:#9aa0b5">Esc</span>
    <button class="btn btn-primary btn-sm">${ic('sparkle',14,1.9)}Analyze</button>
  </div>
  <div class="ov-hint">${ic('camera',14,1.7)} Drag a box around a chart or table <span class="kbd">Esc</span> to cancel</div>`;
}

/* expose */
Object.assign(window, {
  hubTableResult, hubChartResult, hubEmpty, hubLoading, hubError,
  setupScreen, settingsScreen, aboutScreen, permissionScreen,
  popupResult, popupLoading, popupError, captureOverlay
});
