// WORKFLOW DEPTH, end to end in the real app — one launch, five sections.
//
//   1. answers  — the Assistant answers with charts; Explain on a tile
//   2. stories  — a story written with /, outlined, presented, exported; the story action
//   3. catalog  — a tag, a column description, #tag search, the builder tooltip, the Catalog tab
//   4. charts   — waterfall, bullet, calendar heatmap, radar and Pareto built and saved
//   5. tabs     — records as tabs, cycle, close, restore on reload, split view, a second window
//
// Each section lives in its own scripts/wf*.ts module (this file would pass the
// 800-line cap otherwise) and asserts through the shared `ok`, so one verdict
// covers them all. They run IN ORDER against ONE app on the bundled sample
// project, and later sections may rely on what earlier ones left behind.
//
// The model is stubbed at its own boundary (scripts/wfStub.ts — smoke-assistant's
// seam, as a queue); everything after a reply is shipped code. Zero renderer
// console errors across the whole run is the last assertion.
//
//   npm run build && node scripts/smoke-workflow.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, reloadSmoke, finishSmoke } from './smokeFixture';
import { installModelStub, sampleIds } from './wfStub';
import { answersSection } from './wfAnswers';
import { storiesSection } from './wfStories';
import { catalogSection } from './wfCatalog';
import { chartsSection } from './wfCharts';
import { tabsSection } from './wfTabs';

// The hub's own global (tabNav.ts), read inside page.evaluate by its bare name:
// a top-level `let` of a classic script is not a property of window.
declare const tabState: { active: string | null };

async function main(): Promise<void> {
  const s = await launchSmoke('workflow');
  try {
    const stub = await installModelStub(s);
    ok('a fake BYOK key makes the stubbed model ready', stub.ready);
    await reloadSmoke(s);
    const ids = await sampleIds(s);
    ok('the bundled sample project is present', !!ids.projectId && !!ids.datasetId && !!ids.dashboardId, JSON.stringify(ids));
    if (!ids.projectId) return;

    await answersSection(s, ids);
    await storiesSection(s, ids);
    await catalogSection(s);
    // Across sections: the stories written in section 2 are catalog records too.
    const cat = await s.win.evaluate(async (pid: string) => (window as any).hub.catalogList(pid), ids.projectId);
    const storyRows = (cat && Array.isArray(cat.rows) ? cat.rows : []).filter((r: any) => r.kind === 'story').map((r: any) => r.name);
    ok('catalog: the Catalog lists the stories, with what they use counted',
      storyRows.includes('Q4 review') && storyRows.includes('Regional performance'), JSON.stringify(storyRows));
    await chartsSection(s);
    await tabsSection(s);
    // Across sections: a story is a record, so it opens as a tab like the rest.
    const storyTab = await s.win.evaluate(async (pid: string) => {
      const w = window as any;
      const list = await w.hub.listStories(pid);
      const q4 = list.find((x: any) => x.name === 'Q4 review');
      await w.stOpen(q4.id);
      await new Promise((r) => setTimeout(r, 800));
      const active = document.querySelector('#tab-strip .tab-item.is-active .tab-name');
      return { name: (active?.textContent || '').trim(), kind: tabState.active || '' };
    }, ids.projectId);
    ok('tabs: a story opens as a tab, named for the story', storyTab.name === 'Q4 review' && /^story:/.test(storyTab.kind),
      JSON.stringify(storyTab));

    ok('zero renderer console errors across the run', s.errors.length === 0, s.errors.slice(0, 5).join('\n'));
  } finally {
    await s.close();
  }
}

main()
  .then(() => finishSmoke('workflow', failureCount()))
  .catch((e) => { console.error(e); process.exit(1); });
