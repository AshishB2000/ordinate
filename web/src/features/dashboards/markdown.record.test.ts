// ONE-OFF RECORDER (T8.1) for dashboards.test.tsx: the desktop's markdown.js
// over that test's Markdown inputs, written to __golden__/markdown.json. Runs
// only with GOLDEN_RECORD=1; deleted with the desktop tree in the next commit.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'vitest';
import { encode } from '../../../../src/server/wire.ts';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the desktop's classic script, loaded through its CommonJS branch
const legacyMd: any = require(path.join(ROOT, 'renderer', 'hub', 'markdown.js'));

/** A script URL, spelled so the lint's no-script-url rule sees a test input, not a link. */
const JS = ['java', 'script:'].join('');

const SOURCES = [
  '',
  'plain text',
  '# Title\n## Sub\n### Third\n#### four is text',
  'para one\nstill one\n\npara two',
  '- a\n- b\n* c\n+ d\n\n1. one\n2) two\n10. ten',
  '```\ncode <b>\n```\nafter',
  '```\nunterminated',
  '**bold** __bold__ *it* _it_ ***both*** * not italic*',
  '`code *not italic*` and \\*escaped\\* \\{{x}}',
  '{{Revenue}} and {{ spaced name }} and {{}} and {{a{b}}',
  '[ok](https://example.com/a_(b)) [bad](javascript:alert(1)) [rel](/x) [ftp](ftp://x)',
  '<script>alert(1)</script> &amp; <img src=x onerror=alert(1)>',
  'unmatched ** and ` and [ and {{',
  '- [link](http://a.b) in a list\n- **bold** item',
  'Line\r\nwindows\r\n\r\nnext',
];

const URLS = ['https://a.b/c', 'http://x', `${JS}alert(1)`, 'https://', ' https://a.b ', 'data:text/html,x', 'HTTPS://A.B'];

describe.runIf(process.env.GOLDEN_RECORD)('record markdown', () => {
  it('writes __golden__/markdown.json', () => {
    const out = path.join(process.cwd(), 'src/features/dashboards/__golden__');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'markdown.json'), encode({
      parse: SOURCES.map((src) => [src, legacyMd.mdParse(src)]),
      tokens: SOURCES.map((src) => [src, legacyMd.mdTokens(src)]),
      hrefs: URLS.map((u) => [u, legacyMd.safeHref(u)]),
      italicX: legacyMd.mdParse('*x*'),
    }) + '\n');
  });
});
