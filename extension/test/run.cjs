const { runTests } = require('@vscode/test-electron');
const { mkdtemp, writeFile, rm, access } = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agr-host-'));
  const root = path.join(temp, 'fixture');
  await require('node:fs/promises').mkdir(root);
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  await writeFile(path.join(root, 'feature.ts'), 'export const first = 1;\n\nexport const middle = 2;\n\nexport const last = 3;\n');
  git('add', '.'); git('commit', '-qm', 'Initial');
  await writeFile(path.join(root, 'feature.ts'), 'export const first = 10;\n\nexport const middle = 2;\n\nexport const last = 30;\n');
  const helper = path.resolve('skills/agr/scripts/agr.cjs');
  const snapshot = JSON.parse(execFileSync(process.execPath, [helper, 'snapshot', root], { encoding: 'utf8' }));
  await require('node:fs/promises').mkdir(path.join(root, '.agr', '.cache'), { recursive: true });
  await writeFile(path.join(root, '.agr', 'fixture.json'), JSON.stringify({
    version: 1, title: 'Fixture review', summary: 'Fixture summary with context that belongs in the overview.', comparison: 'head-to-working-tree', base: snapshot.base,
    groups: [{ id: 'first', title: 'First concern', steps: [{ id: 'first-step', title: 'Change first value', note: 'Review the first concern.\nKeep [links](command:untrusted) as text.', focus: 'Check the new value.', comments: [{ changeId: snapshot.changes[0].id, side: 'original', start: 1, end: 1, note: 'Previous value.' }, { changeId: snapshot.changes[0].id, side: 'modified', start: 1, end: 1, title: 'New value', note: 'Why the new value matters.' }], changes: [snapshot.changes[0].id] }] },
      { id: 'second', title: 'Second concern', steps: [{ id: 'second-step', title: 'Change last value', note: 'Review the second concern.', changes: [snapshot.changes[1].id] }] }]
  }, null, 2));
  let executable = process.env.VSCODE_EXECUTABLE_PATH;
  if (!executable && process.platform === 'darwin') {
    const local = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
    try { await access(local); executable = local; } catch {}
  }
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: path.resolve('extension'),
      extensionTestsPath: path.resolve('extension/test/suite.cjs'),
      launchArgs: [root, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--user-data-dir', path.join(temp, 'user'), '--extensions-dir', path.join(temp, 'extensions')]
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
