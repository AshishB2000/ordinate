// Self-check for src/projects.ts disk persistence (create/list/get/rename/delete).
// projects.ts requires Electron's `app.getPath('userData')`, so we stub the
// 'electron' module (via Module._load) to point userData at a fresh temp dir,
// then exercise the REAL projects module against real disk. No framework.

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

// Fresh temp userData dir for this run.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-projects-'));

// Stub 'electron' so projects.ts resolves userData under our temp dir. Must be
// installed BEFORE requiring the compiled projects module.
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: the compiled sibling of ../src/projects.ts.
const projects: typeof import('../src/projects') = require('../src/projects');

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

async function main(): Promise<void> {
  // init() creates userData/projects.
  await projects.init();
  ok('init creates the projects dir', fs.existsSync(path.join(tmpUserData, 'projects')));

  // Empty to start.
  let list = await projects.listProjects();
  ok('listProjects is empty initially', Array.isArray(list) && list.length === 0);

  // create.
  const a = await projects.createProject('  Alpha  ');
  ok('createProject returns an id', typeof a.id === 'string' && a.id.length > 0);
  ok('createProject trims the name', a.name === 'Alpha');
  ok('createProject sets schemaVersion 1', a.schemaVersion === 1);
  ok('createProject sets createdAt === updatedAt', a.createdAt === a.updatedAt);
  ok('project.json written to disk',
    fs.existsSync(path.join(tmpUserData, 'projects', a.id, 'project.json')));

  // empty name → fallback.
  const blank = await projects.createProject('   ');
  ok('blank name falls back to Untitled project', blank.name === 'Untitled project');

  // id is not derived from the name (distinct projects, distinct ids).
  ok('ids are unique', a.id !== blank.id);

  // list has both, newest-updated first (blank created last).
  list = await projects.listProjects();
  ok('listProjects returns both projects', list.length === 2);
  ok('listProjects is newest-updated first', list[0].id === blank.id && list[1].id === a.id);

  // get.
  const gotA = await projects.getProject(a.id);
  ok('getProject returns the project', gotA !== null && gotA.id === a.id && gotA.name === 'Alpha');
  const gotMissing = await projects.getProject('does-not-exist');
  ok('getProject returns null for a missing id', gotMissing === null);

  // rename bumps updatedAt and reorders the list to the front.
  await new Promise((r) => setTimeout(r, 5)); // ensure a later timestamp
  const renamed = await projects.renameProject(a.id, 'Beta');
  ok('renameProject returns the updated project', renamed !== null && renamed.name === 'Beta');
  ok('renameProject bumps updatedAt', renamed !== null && renamed.updatedAt > renamed.createdAt);
  ok('renameProject keeps the same id', renamed !== null && renamed.id === a.id);
  const renamedMissing = await projects.renameProject('does-not-exist', 'X');
  ok('renameProject returns null for a missing id', renamedMissing === null);

  // rename persisted to disk.
  const reread = await projects.getProject(a.id);
  ok('rename persisted to disk', reread !== null && reread.name === 'Beta');

  // after rename, a is newest again.
  list = await projects.listProjects();
  ok('rename moves the project to the front', list[0].id === a.id);

  // delete.
  const del = await projects.deleteProject(blank.id);
  ok('deleteProject returns true', del === true);
  ok('deleteProject removes the dir',
    !fs.existsSync(path.join(tmpUserData, 'projects', blank.id)));
  list = await projects.listProjects();
  ok('listProjects reflects the deletion', list.length === 1 && list[0].id === a.id);

  // deleting a missing but WELL-FORMED (uuid) id is a no-op success (fs.rm force).
  const delMissing = await projects.deleteProject('00000000-0000-0000-0000-000000000000');
  ok('deleteProject of a missing uuid succeeds (force)', delMissing === true);

  // SECURITY: ids from the renderer must be validated as UUIDs before any fs op,
  // or a traversal id could delete/read/rename outside userData/projects. Guard
  // rejects non-uuid + traversal ids without touching the filesystem.
  const sentinel = path.join(tmpUserData, 'DO_NOT_DELETE.txt');
  fs.writeFileSync(sentinel, 'keep');
  ok('deleteProject rejects a non-uuid id', (await projects.deleteProject('does-not-exist')) === false);
  ok('deleteProject rejects a "\\.\\." traversal id', (await projects.deleteProject('..')) === false);
  ok('deleteProject rejects a nested traversal id', (await projects.deleteProject('../../foo')) === false);
  ok('traversal delete did NOT touch files outside projects/', fs.existsSync(sentinel));
  ok('getProject rejects a traversal id', (await projects.getProject('../../etc')) === null);
  ok('renameProject rejects a traversal id', (await projects.renameProject('..', 'x')) === null);
}

main()
  .then(() => {
    // Cleanup temp dir.
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' projects check(s) FAILED'); process.exit(1); }
    console.log('\nAll projects checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
