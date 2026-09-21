const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function () {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const extension = vscode.extensions.getExtension('dmitry-zaets.agr');
  assert.ok(extension, 'extension is discovered');
  const app = await extension.activate();
  await app.refresh();
  assert.ok(app.getState().snapshot, app.view.message);
  assert.equal(app.getState().snapshot.changes.length, 2);
  assert.equal(app.getState().items.length, 2, 'two conceptual sections');

  let step = app.getState().items[0].children[0];
  assert.ok(!step.tooltip.value.includes('&nbsp;'), 'prose has normal spaces so comments can wrap');
  assert.ok(step.tooltip.value.includes('\n'), 'authored line breaks are preserved');
  assert.ok(step.tooltip.value.includes('\\[links\\]'), 'guide text remains escaped rather than becoming an executable Markdown link');
  assert.ok(!step.tooltip.isTrusted, 'guide text does not enable trusted commands');
  await vscode.commands.executeCommand(step.command.command, ...step.command.arguments);
  assert.ok(vscode.window.visibleTextEditors.some(e => e.document.uri.scheme === 'agr'), 'native diff snapshot editors opened');
  assert.ok(vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'agr').every(e => e.selection.isEmpty), 'opening a step does not select the reviewed code');
  assert.ok(vscode.workspace.textDocuments.some(d => d.uri.scheme === 'agr' && d.getText().includes('first = 10')), 'working snapshot contains new code');
  const saving = app.toggle(step, true);
  assert.equal(app.getTreeItem(step).description, 'Saving review…', 'feedback appears before disk validation completes');
  assert.equal(app.getTreeItem(step).checkboxState, vscode.TreeItemCheckboxState.Checked);
  await saving;
  let guide = JSON.parse(await fs.readFile(path.join(root, '.agr', 'fixture.json'), 'utf8'));
  assert.equal(guide.groups[0].steps[0].review.status, 'reviewed', 'progress saved to guide');
  assert.ok(guide.groups[0].steps[0].review.fingerprint);
  assert.equal(app.getState().items[0].children[0].checkboxState, vscode.TreeItemCheckboxState.Checked);
  assert.notEqual(app.getTreeItem(app.getState().items[0].children[0]).description, 'Saving review…');
  await Promise.all([app.toggle(step, false), app.toggle(step, true)]);
  guide = JSON.parse(await fs.readFile(path.join(root, '.agr', 'fixture.json'), 'utf8'));
  assert.equal(guide.groups[0].steps[0].review.status, 'reviewed', 'rapid toggles preserve the last requested state');

  await app.navigate(1);
  await app.toggle(undefined, true);
  guide = JSON.parse(await fs.readFile(path.join(root, '.agr', 'fixture.json'), 'utf8'));
  assert.equal(guide.groups[1].steps[0].review.status, 'reviewed', 'next navigates within same file to second concern');
  await fs.writeFile(path.join(root, 'feature.ts'), 'export const first = 100;\n\nexport const middle = 2;\n\nexport const last = 30;\n');
  await app.refresh();
  assert.equal(app.getState().items[0].children[0].description, 'Needs another look');
  assert.equal(app.getState().items[1].children[0].checkboxState, vscode.TreeItemCheckboxState.Checked, 'unrelated hunk remains reviewed');
  assert.equal(app.getState().items[2].children.length, 1, 'edited hunk is uncovered');
  await assert.rejects(app.toggle(app.getState().items[0].children[0], true), /changed/);
  assert.equal(app.getTreeItem(app.getState().items[0].children[0]).checkboxState, vscode.TreeItemCheckboxState.Unchecked, 'failed saves roll back optimistic state');
  assert.notEqual(app.getTreeItem(app.getState().items[0].children[0]).description, 'Saving review…');

  await fs.writeFile(path.join(root, 'new.ts'), 'one\ntwo\nthree\nfour\n');
  await app.refresh();
  const added = app.getState().snapshot.changes.find(c => c.file === 'new.ts');
  guide.groups.push({ id: 'split-file', title: 'Parts of a new file', steps: [
    { id: 'new-first', title: 'First half', note: 'Read the beginning.', changes: [added.id], selections: { [added.id]: { modified: { start: 1, end: 2 } } } },
    { id: 'new-last', title: 'Second half', note: 'Read the ending.', changes: [added.id], selections: { [added.id]: { modified: { start: 3, end: 4 } } } }
  ] });
  // Regenerate the guide like an agent: write the saved artifact directly.
  // An editor buffer may still have the timestamp from before a progress save.
  await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(root, '.agr', 'fixture.json')), Buffer.from(JSON.stringify(guide, null, 2)));
  await app.refresh();
  const lastPart = app.getState().items[2].children[1];
  await app.open(lastPart);
  assert.ok(vscode.window.visibleTextEditors.some(editor => editor.document.uri.path === '/Working-tree/new.ts' && editor.selection.start.line === 2), 'second range opens at line 3 within one added hunk');
  assert.ok(vscode.window.visibleTextEditors.filter(editor => editor.document.uri.path === '/Working-tree/new.ts').every(editor => editor.selection.isEmpty), 'range navigation moves the cursor without a selection overlay');
  await app.toggle(lastPart, true);
  assert.equal(app.getState().items[2].children[0].checkboxState, vscode.TreeItemCheckboxState.Unchecked, 'first slice remains pending');
  assert.equal(app.getState().items[2].children[1].checkboxState, vscode.TreeItemCheckboxState.Checked, 'second slice is reviewed');

  const { execFileSync } = require('node:child_process');
  const helper = path.resolve(__dirname, '../dist/skill/scripts/agr.cjs');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const baseCommit = git('rev-parse', 'HEAD');
  git('add', 'feature.ts');
  await fs.writeFile(path.join(root, 'feature.ts'), 'export const first = 1000;\n\nexport const middle = 2;\n\nexport const last = 30;\n');
  async function loadScope(scope) {
    const recipe = path.join(root, '.agr', '.cache', 'scope.json');
    await fs.writeFile(recipe, JSON.stringify(scope));
    const snapshot = JSON.parse(execFileSync('node', [helper, 'snapshot', root, '--scope', recipe], { encoding: 'utf8' }));
    const scopedGuide = { version: 1, title: 'Scoped review', comparison: snapshot.comparison, base: snapshot.base, scope: snapshot.scope,
      groups: [{ id: 'scoped', title: 'Stages', steps: scope.comparisons.map(c => ({ id: c.id, title: c.id, note: 'Review this version.', changes: snapshot.changes.filter(change => change.comparisonId === c.id).map(change => change.id) })) }] };
    await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(root, '.agr', 'fixture.json')), Buffer.from(JSON.stringify(scopedGuide)));
    await app.refresh();
    assert.equal(app.getState().guide.comparison, 'scoped');
    assert.equal(app.getState().items.length, 1, 'scoped coverage excludes unrelated local files');
  }
  await loadScope({ comparisons: [{ id: 'stage', kind: 'staged', paths: ['feature.ts'] }, { id: 'work', kind: 'unstaged', paths: ['feature.ts'] }] });
  await app.open(app.getState().items[0].children[0]);
  assert.ok(vscode.window.visibleTextEditors.some(e => e.document.uri.path === '/stage/Index/feature.ts' && e.document.getText().includes('first = 100;')), 'staged diff shows index bytes');
  await app.open(app.getState().items[0].children[1]);
  assert.ok(vscode.window.visibleTextEditors.some(e => e.document.uri.path === '/work/Working-tree/feature.ts' && e.document.getText().includes('first = 1000;')), 'unstaged diff shows working bytes');
  await app.toggle(app.getState().items[0].children[0], true);
  assert.equal(app.getState().items[0].children[0].checkboxState, vscode.TreeItemCheckboxState.Checked);
  git('commit', '-qm', 'commit staged version');
  const committed = git('rev-parse', 'HEAD');
  await loadScope({ comparisons: [{ id: 'history', kind: 'revisions', base: baseCommit, head: committed }] });
  await app.open(app.getState().items[0].children[0]);
  assert.ok(vscode.window.visibleTextEditors.some(e => e.document.uri.path === `/history/${committed.slice(0, 8)}/feature.ts` && e.document.getText().includes('first = 100;')), 'committed review ignores unrelated dirty worktree bytes');

  // Fake the transport only: exercise saved progress, queueing and disconnection
  // through the real extension without mutating a user's GitHub account.
  const commands = await vscode.commands.getCommands();
  assert.ok(commands.includes('agr.connectGitHub'));
  assert.ok(commands.includes('agr.disconnectGitHub'));
  const syncKey = app.githubKey(root, 'fixture.json');
  await app.context.workspaceState.update(syncKey, { pr: { repo: 'test/repo', number: 1 }, base: app.getState().guide.base });
  let releaseRequest;
  let gate = new Promise(resolve => { releaseRequest = resolve; });
  const mutations = [];
  app.githubClient = () => async args => {
    await gate;
    if (args.includes('graphql')) { mutations.push(args.join(' ')); return {}; }
    if (args.includes('--paginate')) return [[{ filename: 'feature.ts', status: 'modified' }]];
    if (args[1].includes('/compare/')) return { merge_base_commit: { sha: baseCommit } };
    return { state: 'open', node_id: 'fake-pr', head: { sha: committed }, base: { sha: baseCommit }, changed_files: 1 };
  };
  await app.toggle(app.getState().items[0].children[0], true);
  assert.equal(app.getState().items[0].children[0].checkboxState, vscode.TreeItemCheckboxState.Checked, 'local save completes while GitHub is blocked');
  assert.equal(mutations.length, 0);
  releaseRequest(); await app.githubQueue;
  assert.match(mutations[0], /\{ markFileAsViewed/);
  await Promise.all([app.toggle(app.getState().items[0].children[0], false), app.toggle(app.getState().items[0].children[0], true)]);
  // Superseded jobs may enqueue a fresh read behind the current tail.
  for (let tail; tail !== app.githubQueue;) { tail = app.githubQueue; await tail; }
  assert.match(mutations.at(-1), /\{ markFileAsViewed/, 'rapid toggles end at the latest saved state');
  gate = new Promise(resolve => { releaseRequest = resolve; });
  await app.toggle(app.getState().items[0].children[0], false);
  await app.disconnectGitHub();
  const beforeDisconnect = mutations.length;
  releaseRequest(); await app.githubQueue;
  assert.equal(mutations.length, beforeDisconnect, 'disconnect cancels queued writes');

  // Two guides deliberately share step IDs: identity and writes must stay isolated.
  const firstFile = path.join(root, '.agr', 'fixture.json');
  const firstBefore = await fs.readFile(firstFile, 'utf8');
  const alternate = JSON.parse(firstBefore);
  alternate.title = 'Second review';
  for (const group of alternate.groups) for (const entry of group.steps) entry.review = { status: 'pending' };
  const secondFile = path.join(root, '.agr', 'second.json');
  await fs.writeFile(secondFile, JSON.stringify(alternate));
  await fs.writeFile(path.join(root, 'agr.json'), '{"not":"a supported guide"}');
  await app.refresh();
  assert.deepEqual(app.getState().reviews.map(review => review.file), ['fixture.json', 'second.json']);
  const oldItem = app.getState().items[0].children[0];
  await app.selectReview('second.json');
  assert.equal(app.getState().reviewFile, 'second.json');
  assert.equal(app.getState().items[0].children[0].checkboxState, vscode.TreeItemCheckboxState.Unchecked);
  await assert.rejects(app.toggle(oldItem, true), /active review changed/);
  await assert.rejects(app.open(oldItem), /active review changed/);
  await app.open(app.getState().items[0].children[0]);
  const savingSecond = app.toggle(app.getState().items[0].children[0], true);
  const switching = app.selectReview('fixture.json');
  await Promise.all([savingSecond, switching]);
  assert.equal(await fs.readFile(firstFile, 'utf8'), firstBefore, 'switching never writes progress to another guide');
  assert.equal(JSON.parse(await fs.readFile(secondFile, 'utf8')).groups[0].steps[0].review.status, 'reviewed');
  await app.selectReview('second.json'); await app.refresh();
  assert.equal(app.getState().reviewFile, 'second.json', 'refresh keeps the selected review');
  assert.equal(app.getState().items[0].children[0].checkboxState, vscode.TreeItemCheckboxState.Checked);

  const badFile = path.join(root, '.agr', 'broken.json');
  await fs.writeFile(badFile, '{'); await app.refresh();
  await app.selectReview('broken.json');
  assert.equal(app.getState().snapshot, undefined, 'invalid guides never reuse another guide snapshot');
  assert.match(app.view.message, /Guide error/);
  await app.selectReview('second.json');
  assert.ok(app.getState().snapshot, 'an invalid guide does not block another review');
  const unavailable = structuredClone(alternate);
  unavailable.scope.comparisons[0].head = 'a'.repeat(40);
  await fs.writeFile(path.join(root, '.agr', 'missing-commits.json'), JSON.stringify(unavailable));
  await app.refresh(); await app.selectReview('missing-commits.json');
  assert.equal(app.getState().snapshot, undefined);
  assert.equal(app.getState().guide.title, 'Second review', 'notes remain accessible when commits are missing');
  assert.ok(app.getState().items[0].children[0].tooltip.value);
  assert.equal(app.getState().items[0].children[0].command, undefined, 'unavailable steps cannot be opened or approved');
  await app.selectReview('second.json');
  await fs.unlink(secondFile); await fs.unlink(badFile);
  await fs.unlink(path.join(root, '.agr', 'missing-commits.json'));
  await app.refresh();
  assert.equal(app.getState().reviewFile, 'fixture.json', 'deleting a selected guide chooses the remaining review');

  await app.installSkill('repository');
  for (const folder of ['.agents', '.claude']) {
    assert.ok((await fs.readFile(path.join(root, folder, 'skills/agr/SKILL.md'), 'utf8')).includes('name: agr'));
    await fs.access(path.join(root, folder, 'skills/agr/scripts/agr.cjs'));
  }
  console.log('PASS: multiple review isolation, switching, invalid and unavailable reviews, native diffs, immediate saved progress, navigation, invalidation, ranges, safe wrapped comments, staged/unstaged/commit scopes, and both skill installations.');
};
