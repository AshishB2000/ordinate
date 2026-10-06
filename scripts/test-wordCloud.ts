// The word cloud, server side: the caption reads the size measure alone and
// skips the folded "Other" bucket, and the cap that bucket is folded at is the
// one the desktop's word cloud drew with (its wordCloudLayout.js copy of
// categoryKey's cap and label, recorded at the T8.1 cutover —
// scripts/fixtures/golden/wordCloud.json). The layout itself is the web chart
// engine's: web/src/charts/wordCloudLayout.test.ts.
//
//   npm run build:ts && node scripts/test-wordCloud.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { golden } from './golden';
import * as categoryKey from '../src/analysis/categoryKey';
import { tileCaption } from '../src/analysis/captions';

const desktop = golden<{ categoryCap: number; otherLabel: string }>('wordCloud');
ok('drift guard: the desktop\'s cap and label ARE categoryKey\'s',
  desktop.categoryCap === categoryKey.CATEGORY_CAP && desktop.otherLabel === categoryKey.OTHER_LABEL,
  JSON.stringify([desktop.categoryCap, categoryKey.CATEGORY_CAP, desktop.otherLabel, categoryKey.OTHER_LABEL]));
const capped = Array.from({ length: categoryKey.CATEGORY_CAP }, (_, i) => 'w' + i).concat([categoryKey.OTHER_LABEL]);

// ── The caption reads the size measure alone, and skips the bucket ──────────
{
  const data = { labels: ['service', 'parking', 'staff'], series: [{ name: 'sum of count', values: [12, 30, 5] }, { name: 'avg of sentiment', values: [0.2, -0.4, 0.6] }] };
  const cap = tileCaption({ chartType: 'word_cloud', data } as any);
  ok('caption: the biggest word, its figure, the runner-up ratio, the colour measure',
    cap === '“parking” is the biggest of 3 words, count 30, 2.5× “service”; coloured by sentiment', cap);
  const many = { labels: capped, series: [{ name: 'sum of count', values: capped.map((_, i) => (i === capped.length - 1 ? 999 : 50 - i)) }] };
  const c2 = tileCaption({ chartType: 'word_cloud', data: many } as any);
  ok('caption: the folded "Other" tail is never the biggest word', /^“w0” is the biggest of 50 words/.test(c2), c2);
}

finish();
