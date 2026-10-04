// E2E (T2.2): projects, the Trash and version history against the real server
// (dev sign-in, records as files, the seeded sample project plus
// seed-history.ts: two saves of one visual, two visuals in the Trash).
//
//   switcher   lists the sample, New project → switches, Rename, switch back,
//              Archive → folded away → Restore
//   Trash      the two deleted visuals with days left → Restore one → Delete
//              the other permanently → the designed empty state
//   versions   the visual's two saves → preview the older → Restore → three
//              saves, the newest "Restored from"
//   bundle     Export project → a real browser download → Import project (an
//              upload) → a new project with the same name → Delete it, name
//              typed back
//
// Screens in both themes go to web/e2e/__screens__/projects-*.png. Sharing
// needs Postgres: projects-share.e2e.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { e2e, screens, SCREENS, settled, type Session } from './fixtures.ts';

const SEED = fileURLToPath(new URL('./seed-history.ts', import.meta.url));
const switcher = (page: Page) => page.getByTestId('project-switcher');

/** One screenshot per theme of a state that a reload would close (an open popover): `open` re-creates it. */
async function shotOpen(page: Page, name: string, open: () => Promise<void>): Promise<string[]> {
  const files: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
    await page.reload();
    await settled(page);
    await open();
    const file = path.join(SCREENS, `${name}-${theme}.png`);
    await page.screenshot({ path: file, animations: 'disabled' }); // the popover's entrance, finished
    files.push(file);
  }
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
  await page.reload();
  await settled(page);
  return files;
}

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
}

e2e('projects: switcher, Trash, version history and the bundle round trip', async (s) => {
  const { page, server } = s;
  const sample = server.sample.projectName;
  const seeded = spawnSync(process.execPath, [SEED, server.dataDir, server.sample.projectId], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(seeded.status, 0, seeded.stderr);
  const seed = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { visualId: string; original: string; edited: string; trashed: string[] };

  // ── Switcher ────────────────────────────────────────────────────────────
  await page.goto('/');
  await settled(page);
  await page.waitForFunction((n) => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes(n), sample);
  await switcher(page).click();
  const pop = page.getByRole('dialog', { name: 'Projects' });
  await pop.getByRole('listitem').filter({ hasText: sample }).waitFor();
  assert.equal(await pop.getByRole('listitem').count(), 1);
  assert.equal(await pop.getByRole('listitem').filter({ hasText: sample }).getByText('Sample').count(), 1, 'the sample badge');
  await shotOpen(page, 'projects-switcher', async () => {
    await switcher(page).click();
    await pop.getByRole('listitem').first().waitFor();
  });

  await switcher(page).click();
  await pop.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('E2E project');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('Created “E2E project”.').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes('E2E project'));

  await switcher(page).click();
  await pop.getByRole('button', { name: 'E2E project options' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Project name').fill('E2E renamed');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes('E2E renamed'));
  // A fresh load (the RPC budget is per load): the choice survives it (localStorage).
  await page.reload();
  await settled(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes('E2E renamed'));

  await switcher(page).click();
  await pop.getByRole('button', { name: 'E2E renamed options' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await page.getByText('Archived “E2E renamed”.').waitFor();
  await page.waitForFunction((n) => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes(n), sample);
  await switcher(page).click();
  await pop.getByRole('button', { name: 'Archived (1)' }).click();
  await pop.getByRole('button', { name: 'Restore E2E renamed' }).click();
  await page.getByText('Restored “E2E renamed”.').waitFor();
  await switcher(page).click();
  await pop.getByRole('listitem').nth(1).waitFor();
  assert.equal(await pop.getByRole('button', { name: /^Archived/ }).count(), 0, 'nothing archived any more');
  // By keyboard: the arrows move between rows, Enter switches (archiving made the sample current).
  await pop.getByRole('listitem').first().getByRole('button').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes('E2E renamed'));
  await switcher(page).click();
  await pop.getByRole('listitem').filter({ hasText: sample }).getByRole('button').first().click();
  await page.waitForFunction((n) => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes(n), sample);

  // ── Trash ───────────────────────────────────────────────────────────────
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Trash' }).click();
  await page.getByRole('heading', { level: 1, name: 'Trash' }).waitFor();
  for (const n of seed.trashed) await page.getByRole('cell', { name: n, exact: true }).waitFor();
  assert.equal(await page.getByText('30 days left').count(), 2);
  await screens(page, 'projects-trash');
  await page.getByRole('button', { name: `Restore ${seed.trashed[0]}` }).click();
  await page.getByText(`Restored “${seed.trashed[0]}”`).waitFor();
  await page.getByRole('button', { name: `Delete ${seed.trashed[1]} permanently` }).click();
  await page.getByRole('dialog', { name: `Delete “${seed.trashed[1]}” permanently?` }).getByRole('button', { name: 'Delete permanently' }).click();
  await page.getByRole('heading', { name: 'Trash is empty' }).waitFor();
  await screens(page, 'projects-trash-empty');

  // ── Version history ─────────────────────────────────────────────────────
  await page.goto(`/versions/${server.sample.projectId}/visual/${seed.visualId}`);
  await settled(page);
  await page.getByRole('heading', { level: 1, name: `${seed.edited} — version history` }).waitFor();
  const saves = page.getByRole('region', { name: 'Saved versions' }).getByRole('button', { pressed: false });
  assert.equal(await saves.count(), 1, 'one older save besides the current one');
  await screens(page, 'projects-versions');
  await saves.first().click();
  await page.getByText(/^Viewing version from/).waitFor();
  await page.getByRole('region', { name: 'Version preview' }).getByText(seed.original, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByText(/^Restored the version from/).waitFor();
  await page.getByRole('heading', { level: 1, name: `${seed.original} — version history` }).waitFor();
  await page.getByText(/^Restored from /).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Saved versions' }).getByRole('button').count(), 3);

  // ── Bundle: export (download) → import (upload) → delete ────────────────
  await page.goto('/');
  await settled(page);
  await switcher(page).click();
  await pop.getByRole('button', { name: `${sample} options` }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export project' }).click()]);
  assert.equal(download.suggestedFilename(), `${sample}.ordinate`);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'ordinate-e2e-bundle-')), download.suggestedFilename());
  await download.saveAs(file);
  assert.ok(statSync(file).size > 1000, 'the bundle has content');
  await page.getByText(`Exported “${sample}”.`).waitFor();

  await page.locator('input[type=file][accept=".ordinate"]').setInputFiles(file);
  // A name already taken gets " (imported)" (src/app/bundle.ts), and the import becomes current.
  const copy = `${sample} (imported)`;
  // The counts are the bundle's manifest (the server's), as many as the sample holds.
  await page.getByText(new RegExp(`^Imported “${copy.replace(/[()]/g, '\\$&')}” — \\d+ datasets?, \\d+ visuals?, \\d+ dashboards?\\.$`)).waitFor();
  await page.waitForFunction((n) => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes(n), copy);
  await switcher(page).click();
  await pop.getByRole('button', { name: `${copy} options` }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const del = page.getByRole('dialog', { name: `Delete ${copy}?` });
  const confirm = del.getByRole('button', { name: 'Delete project' });
  assert.equal(await confirm.isDisabled(), true, 'disabled until the name is typed back');
  await del.getByLabel(`Type “${copy}” to confirm`).fill(copy);
  await confirm.click();
  await page.getByText(`Deleted “${copy}”.`).waitFor();
  await page.waitForFunction((n) => document.querySelector('[data-testid="project-switcher"]')?.textContent?.includes(n), sample);
  await switcher(page).click();
  assert.equal(await pop.getByText(copy).count(), 0, 'the imported copy is gone');
  assert.equal(await pop.getByRole('listitem').count(), 2, 'the sample and E2E renamed stay');
  await page.keyboard.press('Escape');
  report(s);
});
