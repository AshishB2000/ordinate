/* ============================================================
   Screenchart — sample data, SVG chart helpers, mock captures,
   icons. Charts are representative placeholders drawn from
   sensible sample data in the brand chart palette.
   ============================================================ */

/* ---------- chart palette ---------- */
const PAL = { blue:'#3B82F6', teal:'#14B8A6', amber:'#F59E0B', violet:'#8B5CF6', rose:'#F43F5E' };

/* ---------- sample datasets ---------- */
// TABLE → CHART mode: quarterly revenue by region ($K)
const REGION = {
  cols: ['Q1','Q2','Q3','Q4'],
  rows: [
    { name:'North', color: PAL.blue,   v:[142,158,171,195] },
    { name:'South', color: PAL.teal,   v:[ 98,112,120,138] },
    { name:'West',  color: PAL.amber,  v:[176,169,188,210] },
    { name:'East',  color: PAL.violet, v:[ 87, 95,102,118] },
  ]
};
// CHART mode: monthly active users (K)
const MAU = {
  months: ['J','F','M','A','M','J','J','A','S','O','N','D'],
  v: [12,14,15,17,19,22,24,21,25,27,29,31]
};

/* ============================================================
   ICONS  (stroke, currentColor, 24-grid)
   ============================================================ */
function ic(name, size=16, sw=1.7){
  const P = {
    camera:'<path d="M3 8.5A2 2 0 0 1 5 6.5h1.2l.8-1.4A1.5 1.5 0 0 1 8.3 4.3h7.4a1.5 1.5 0 0 1 1.3.8l.8 1.4H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.4"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    search:'<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.6-3.6"/>',
    gear:'<circle cx="12" cy="12" r="3"/><path d="M12 2.6l1 2.3 2.5-.5.6 2.5 2.3 1-1 2.3 1 2.3-2.3 1-.6 2.5-2.5-.5-1 2.3-1-2.3-2.5.5-.6-2.5-2.3-1 1-2.3-1-2.3 2.3-1 .6-2.5 2.5.5z" transform="scale(0.86) translate(2 2)"/>',
    send:'<path d="M5 12l15-7-5 7 5 7z"/>',
    sparkle:'<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6zM18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    clip:'<path d="M18 8.5l-7.4 7.4a3 3 0 0 1-4.2-4.2L13 4.1a2 2 0 0 1 2.8 2.8l-7 7a1 1 0 0 1-1.4-1.4l6.3-6.3"/>',
    chevd:'<path d="M6 9l6 6 6-6"/>',
    chevr:'<path d="M9 6l6 6-6 6"/>',
    check:'<path d="M4 12.5l5 5 11-11"/>',
    alert:'<path d="M12 3.5L22 19.5H2zM12 10v4M12 17.2v.1"/>',
    xcircle:'<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
    refresh:'<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v3.5h-3.5"/>',
    key:'<circle cx="8" cy="14" r="3.5"/><path d="M10.5 11.5L20 2M16 6l2.5 2.5M18 8l1.8 1.8"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.1"/>',
    lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    eye:'<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
    bars:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    line:'<path d="M3 20h18M5 15l4-5 4 3 6-8"/>',
    table:'<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 10h17M9 10v9M3.5 14.5h17"/>',
    arrowr:'<path d="M5 12h14M13 6l6 6-6 6"/>',
    cmd:'<path d="M9 6a2.5 2.5 0 1 0-2.5 2.5H9zm0 0v12m0-12h6m0 0V6a2.5 2.5 0 1 1 2.5 2.5H15zm0 0H9m6 0v9m0 0a2.5 2.5 0 1 0 2.5 2.5V15zm0 0H9m0 0v.5A2.5 2.5 0 1 1 6.5 15H9z"/>',
    monitor:'<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
    shield:'<path d="M12 3l7 2.5v5c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9v-5z"/>',
    ext:'<path d="M14 5h5v5M19 5l-8 8M18 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5H11"/>',
    clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    book:'<path d="M5 4.5h11A2.5 2.5 0 0 1 18.5 7v12.5H7A2 2 0 0 0 5 21.5zM18.5 19.5H7A2 2 0 0 0 5 21.5V6.5"/>',
    spinner:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" opacity=".9"/>',
    bolt:'<path d="M13 3L5 13h5l-1 8 8-10h-5z"/>',
    msg:'<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-5A8 8 0 1 1 21 12z"/>',
    wifi:'<path d="M5 12.5a10 10 0 0 1 14 0M8 16a5.5 5.5 0 0 1 8 0M12 19.2v.1"/>',
  };
  const d = P[name] || '';
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
function icFill(name, size=16){
  const P = {
    check:'<path d="M5 13l4 4 10-11" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    spark:'<path d="M12 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="currentColor"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${P[name]||''}</svg>`;
}

/* ============================================================
   CHART HELPERS
   ============================================================ */

// Generated bar chart (table → chart). Theme-aware axes via CSS vars.
function barChartThemed(w=400, h=232){
  const padL=34, padR=10, padT=12, padB=34;
  const x0=padL, x1=w-padR, y0=padT, y1=h-padB;
  const maxV=220;
  const groups=REGION.cols.length, series=REGION.rows.length;
  const gW=(x1-x0)/groups;
  const bGap=3, gInset=10;
  const bW=(gW-gInset*2-bGap*(series-1))/series;
  const yOf=v=> y1-(v/maxV)*(y1-y0);
  let g='';
  // gridlines
  for(let i=0;i<=4;i++){
    const gv=maxV/4*i, y=yOf(gv);
    g+=`<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;
    g+=`<text x="${x0-7}" y="${(y+3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--faint)">${gv}</text>`;
  }
  REGION.cols.forEach((c,gi)=>{
    const gx=x0+gi*gW;
    REGION.rows.forEach((r,si)=>{
      const v=r.v[gi];
      const bx=gx+gInset+si*(bW+bGap);
      const by=yOf(v), bh=y1-by;
      g+=`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${r.color}"/>`;
    });
    g+=`<text x="${(gx+gW/2).toFixed(1)}" y="${y1+16}" text-anchor="middle" font-size="10.5" font-weight="600" fill="var(--muted)">${c}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block" font-family="system-ui,sans-serif">${g}</svg>`;
}

// Line chart for the dashboard mock (captured screenshot → fixed colors)
function lineChartMock(w=360, h=176){
  const padL=24, padR=12, padT=14, padB=24;
  const x0=padL, x1=w-padR, y0=padT, y1=h-padB;
  const data=MAU.v, n=data.length, maxV=34;
  const xOf=i=> x0+(i/(n-1))*(x1-x0);
  const yOf=v=> y1-(v/maxV)*(y1-y0);
  let grid='';
  for(let i=0;i<=3;i++){ const y=y0+(i/3)*(y1-y0); grid+=`<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="#eceef2" stroke-width="1"/>`; }
  const pts=data.map((v,i)=>`${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`);
  const area=`M${xOf(0).toFixed(1)},${y1} L`+pts.join(' L')+` L${xOf(n-1).toFixed(1)},${y1} Z`;
  let lbls='';
  MAU.months.forEach((m,i)=>{ lbls+=`<text x="${xOf(i).toFixed(1)}" y="${h-8}" text-anchor="middle" font-size="9" fill="#9aa0ad">${m}</text>`; });
  // highlight Aug dip (index 7)
  const ax=xOf(7), ay=yOf(data[7]);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block" font-family="system-ui,sans-serif">
    ${grid}
    <path d="${area}" fill="${PAL.blue}" opacity="0.10"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${PAL.blue}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    ${data.map((v,i)=>`<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="2.2" fill="#fff" stroke="${PAL.blue}" stroke-width="1.6"/>`).join('')}
    <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="4.6" fill="#fff" stroke="${PAL.rose}" stroke-width="2"/>
    <line x1="${ax.toFixed(1)}" y1="${(ay+7).toFixed(1)}" x2="${ax.toFixed(1)}" y2="${y1}" stroke="${PAL.rose}" stroke-width="1" stroke-dasharray="2 2" opacity=".5"/>
    ${lbls}
  </svg>`;
}

/* ---------- mini thumbnails for history list ---------- */
function thumbBars(){
  const c=[PAL.blue,PAL.teal,PAL.amber,PAL.violet]; let r='';
  const hs=[10,16,12,20,14,9];
  hs.forEach((hh,i)=>{ r+=`<rect x="${4+i*6}" y="${24-hh}" width="4" height="${hh}" rx="1" fill="${c[i%4]}"/>`; });
  return `<svg viewBox="0 0 40 30">${r}</svg>`;
}
function thumbLine(){
  const pts="3,20 9,15 15,17 21,9 27,12 37,5";
  return `<svg viewBox="0 0 40 30"><polyline points="${pts}" fill="none" stroke="${PAL.blue}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3,20 9,15 15,17 21,9 27,12 37,5 37,27 3,27Z" fill="${PAL.blue}" opacity=".12"/></svg>`;
}
function thumbTable(){
  let r='<rect x="3" y="4" width="34" height="22" rx="2" fill="#fff" stroke="#dfe2e8"/>';
  r+='<rect x="3" y="4" width="34" height="6" fill="#eef0f4"/>';
  for(let i=1;i<4;i++) r+=`<line x1="3" y1="${4+i*5.5}" x2="37" y2="${4+i*5.5}" stroke="#eceef2"/>`;
  for(let i=1;i<3;i++) r+=`<line x1="${3+i*11.3}" y1="4" x2="${3+i*11.3}" y2="26" stroke="#eceef2"/>`;
  return `<svg viewBox="0 0 40 30">${r}</svg>`;
}
function thumbFunnel(){
  const w=[30,22,15,9],c=[PAL.violet,PAL.violet,PAL.violet,PAL.violet];let r='';
  w.forEach((ww,i)=>{ r+=`<rect x="${(40-ww)/2}" y="${4+i*6}" width="${ww}" height="4.4" rx="1" fill="${PAL.violet}" opacity="${1-i*0.18}"/>`; });
  return `<svg viewBox="0 0 40 30">${r}</svg>`;
}
function thumbArea(){
  return `<svg viewBox="0 0 40 30"><path d="M3,22 11,12 19,16 27,8 37,11 37,27 3,27Z" fill="${PAL.teal}" opacity=".18"/><polyline points="3,22 11,12 19,16 27,8 37,11" fill="none" stroke="${PAL.teal}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/* ============================================================
   MOCK "captured" content (always light — it's a screenshot)
   ============================================================ */
function mockDashboard(){
  return `<div class="mock mock-dash">
    <div class="mh">
      <div class="t">Monthly Active Users</div>
      <div class="s">Jan – Dec 2025 · Growth dashboard</div>
    </div>
    <div class="mock-kpis">
      <div class="mock-kpi"><div class="v">31.2K</div><div class="l">Active users <span class="up">▲ 158% YoY</span></div></div>
      <div class="mock-kpi"><div class="v">+2.0K</div><div class="l">Net new · Dec</div></div>
      <div class="mock-kpi"><div class="v">21.4K</div><div class="l">Aug low</div></div>
    </div>
    ${lineChartMock(360,168)}
  </div>`;
}
function mockSpreadsheet(){
  const colLetters=['A','B','C','D','E'];
  const head='<tr><th class="corner"></th>'+colLetters.map(c=>`<th class="colh">${c}</th>`).join('')+'</tr>';
  const titleRow=`<tr><td class="corner">1</td><td colspan="5" style="text-align:left;font-weight:700;color:#1f2330;background:#fff">Quarterly Revenue by Region&nbsp;&nbsp;($K)</td></tr>`;
  const h2=`<tr><td class="corner">2</td><th style="text-align:left">Region</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th></tr>`;
  const bodyRows=REGION.rows.map((r,ri)=>
    `<tr><td class="corner">${ri+3}</td><td style="text-align:left;font-weight:600;color:#4b5160;background:#fbfbfc">${r.name}</td>${r.v.map(v=>`<td>${v}</td>`).join('')}</tr>`
  ).join('');
  return `<div class="mock mock-sheet">
    <table>
      <thead>${head}</thead>
      <tbody>${titleRow}${h2}${bodyRows}</tbody>
    </table>
  </div>`;
}

/* small inline chart for popup (themed bars, compact) */
function barChartCompact(){ return barChartThemed(330, 150); }
