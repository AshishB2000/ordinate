import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.SCREENCHART_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-icons-'));

const icons = require('../src/icons') as Record<string, any>;

let failures = 0;
function ok(label: string, cond: boolean, extra = ''): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else { console.error('FAIL ' + label + (extra ? '  ' + extra : '')); failures++; }
}

const mapped = icons.CONNECTOR_SI || {};
const logos = icons.connectorLogos || {};

ok('PostgreSQL has an explicit official mapping', mapped.postgres === 'siPostgresql');
ok('mapped PostgreSQL resolves to a bundled path',
  typeof logos.postgres?.path === 'string' && logos.postgres.path.length > 20);
ok('Amazon Redshift resolves to the supplied local PNG',
  typeof logos['amazon-redshift']?.src === 'string' &&
  logos['amazon-redshift'].src.startsWith('data:image/png;base64,'));
ok('connector logos are structured-clone safe', (() => {
  try { structuredClone(logos); return true; } catch (_) { return false; }
})());
ok('connector logos expose no filesystem paths or functions', (() => {
  const json = JSON.stringify(logos);
  return !json.includes('/Users/') && !json.includes('/var/folders/') &&
    !Object.values(logos).some((v: any) => Object.values(v).some((x) => typeof x === 'function'));
})());

fs.rmSync(process.env.SCREENCHART_USER_DATA, { recursive: true, force: true });
if (failures) process.exit(1);
console.log('\nAll connector icon checks passed.');
