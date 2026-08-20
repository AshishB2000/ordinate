import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.SCREENCHART_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-icons-'));

const icons = require('../src/app/icons') as Record<string, any>;
const { connectorCatalog } = require('../src/connectors') as {
  connectorCatalog: () => { id: string }[];
};

const ROOT = path.join(__dirname, '..');
const iconDir = path.join(ROOT, 'assets', 'icons');
const ordinateSvg = fs.readFileSync(path.join(iconDir, 'ordinate.svg'), 'utf8');
const markSvg = fs.readFileSync(path.join(iconDir, 'mark.svg'), 'utf8');
const connectionsSource = fs.readFileSync(path.join(ROOT, 'renderer', 'hub', 'connections.ts'), 'utf8');

function pngSize(file: string): { width: number; height: number } | null {
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.subarray(1, 4).toString('ascii') !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let failures = 0;
function ok(label: string, cond: boolean, extra = ''): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else { console.error('FAIL ' + label + (extra ? '  ' + extra : '')); failures++; }
}

const mapped = icons.CONNECTOR_SI || {};
const logos = icons.connectorLogos || {};
const catalogIds = connectorCatalog().map((d) => d.id);
const missing = catalogIds.filter((id) => {
  const logo = logos[id];
  return !(typeof logo?.path === 'string' && logo.path.length > 20) &&
    !(typeof logo?.src === 'string' && logo.src.startsWith('data:image/'));
});

ok('PostgreSQL has an explicit official mapping', mapped.postgres === 'siPostgresql');
ok('mapped PostgreSQL resolves to a bundled path',
  typeof logos.postgres?.path === 'string' && logos.postgres.path.length > 20);
ok('Amazon Redshift resolves to the supplied local PNG',
  typeof logos['amazon-redshift']?.src === 'string' &&
  logos['amazon-redshift'].src.startsWith('data:image/png;base64,'));
ok('catalog exposes exactly 35 unique connector ids',
  catalogIds.length === 35 && new Set(catalogIds).size === 35,
  JSON.stringify(catalogIds));
ok('all 35 catalog connectors resolve to real marks',
  missing.length === 0,
  JSON.stringify(missing));
ok('connector logos are structured-clone safe', (() => {
  try { structuredClone(logos); return true; } catch (_) { return false; }
})());
ok('connector logos expose no filesystem paths or functions', (() => {
  const json = JSON.stringify(logos);
  return !json.includes('/Users/') && !json.includes('/var/folders/') &&
    !Object.values(logos).some((v: any) => Object.values(v).some((x) => typeof x === 'function'));
})());
ok('connector logos contain no executable or external image references', (() => {
  return !Object.values(logos).some((v: any) => {
    if (typeof v?.src !== 'string') return false;
    if (/^(?:https?:|file:)/i.test(v.src)) return true;
    const prefix = 'data:image/svg+xml;base64,';
    if (!v.src.startsWith(prefix)) return false;
    const svg = Buffer.from(v.src.slice(prefix.length), 'base64').toString('utf8');
    return /<script\b|javascript:|@import\b|url\(\s*["']?\s*(?:https?:|file:|\/\/)|(?:href|src)\s*=\s*["']\s*(?:https?:|file:|\/\/)/i.test(svg);
  });
})());

const forbiddenSvgReference = /<image\b|data:image|(?:href|src)\s*=\s*["'](?:https?:|file:)/i;
ok('light app icon is native vector artwork',
  ordinateSvg.includes('<path') && !forbiddenSvgReference.test(ordinateSvg));
ok('bare app mark is native vector artwork',
  markSvg.includes('<path') && !forbiddenSvgReference.test(markSvg));
ok('light app icon keeps the centered 824px rounded tile',
  /<rect\b[^>]*x="100"[^>]*width="824"[^>]*rx="184"/.test(ordinateSvg));
ok('obsolete 200px raster source is removed',
  !fs.existsSync(path.join(iconDir, 'reference', 'cube-insight-200.png')));
ok('generated app PNG is 1024×1024',
  JSON.stringify(pngSize(path.join(iconDir, 'icon.png'))) ===
    JSON.stringify({ width: 1024, height: 1024 }));
ok('Screenchart source PNG is bundled at 1024×1024',
  JSON.stringify(pngSize(path.join(ROOT, 'renderer', 'hub', 'assets', 'connectors', 'screenchart.png'))) ===
    JSON.stringify({ width: 1024, height: 1024 }));
ok('Home Screenshot uses the bundled Screenchart image',
  /'home-capture':\s*\{\s*src:\s*'assets\/connectors\/screenchart\.png'/.test(connectionsSource));
ok('app-icon generator is tracked as source',
  fs.existsSync(path.join(ROOT, 'scripts', 'build-appicon.js')));

fs.rmSync(process.env.SCREENCHART_USER_DATA, { recursive: true, force: true });
if (failures) process.exit(1);
console.log('\nAll connector icon checks passed.');
