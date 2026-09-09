import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, rename, chmod, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, snapshotRepository, safePath } from '../src/git';
import { Guide, parseGuide, selectedChanges, stepFingerprint, stepState, uncoveredChanges, validateCoverage } from '../src/model';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, commit = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agr-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, 'logic.ts'), 'const first = 1;\n\nconst middle = 2;\n\nconst last = 3;\n');
  if (commit) { await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'Initial']); }
  return root;
}
function guide(base: string | null, ids: string[]): Guide {
  return { version: 1, title: 'Feature', comparison: 'head-to-working-tree', base,
    groups: [{ id: 'feature', title: 'Behavior', steps: ids.map((id, i) => ({ id: `step-${i}`, title: `Concern ${i}`, note: 'Explain why.', changes: [id] })) }] };
}

test('separate hunks in one file have independent coverage and approval', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'logic.ts'), 'const first = 10;\n\nconst middle = 2;\n\nconst last = 30;\n');
  const snapshot = await snapshotRepository(root);
  assert.equal(snapshot.changes.length, 2);
  const g = guide(snapshot.base, [snapshot.changes[0].id]);
  const step = g.groups[0].steps[0];
  step.review = { status: 'reviewed', fingerprint: stepFingerprint(step, snapshot) };
  assert.equal(stepState(step, snapshot, g.base), 'reviewed');
  assert.deepEqual(uncoveredChanges(g, snapshot).map(c => c.id), [snapshot.changes[1].id]);
  await writeFile(path.join(root, 'logic.ts'), 'const first = 10;\n\nconst middle = 2;\n\nconst last = 300;\n');
  const later = await snapshotRepository(root);
  assert.equal(stepState(step, later, g.base), 'reviewed');
  await writeFile(path.join(root, 'logic.ts'), 'const first = 100;\n\nconst middle = 2;\n\nconst last = 300;\n');
  assert.equal(stepState(step, await snapshotRepository(root), g.base), 'stale');
});

test('staged and unstaged edits form one comparison; staging preserves IDs', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'logic.ts'), 'const first = 10;\n\nconst middle = 2;\n\nconst last = 3;\n');
  await git(root, ['add', '.']);
  await writeFile(path.join(root, 'logic.ts'), 'const first = 10;\n\nconst middle = 2;\n\nconst last = 30;\n');
  const before = await snapshotRepository(root);
  assert.equal(before.changes.length, 2);
  await git(root, ['add', '.']);
  assert.deepEqual((await snapshotRepository(root)).changes, before.changes);
});

test('untracked text keeps its identity when staged, including missing newline', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'new file.ts'), 'one\ntwo');
  const before = await snapshotRepository(root);
  await git(root, ['add', '.']);
  const after = await snapshotRepository(root);
  assert.equal(after.changes[0].id, before.changes[0].id);
});

test('binary files are visible and invalidate on content changes', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'asset.bin'), Buffer.from([0, 1, 2]));
  const before = await snapshotRepository(root);
  assert.equal(before.changes[0].kind, 'binary');
  await writeFile(path.join(root, 'asset.bin'), Buffer.from([0, 3, 2]));
  assert.notEqual((await snapshotRepository(root)).changes[0].id, before.changes[0].id);
});

test('a unique hunk retains its identity when unrelated changes shift its lines', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'logic.ts'), 'const first = 1;\n\nconst middle = 2;\n\nconst last = 30;\n');
  const before = await snapshotRepository(root);
  await writeFile(path.join(root, 'logic.ts'), '// heading\nconst first = 1;\n\nconst middle = 2;\n\nconst last = 30;\n');
  const after = await snapshotRepository(root);
  assert.ok(after.changes.some(c => c.id === before.changes[0].id));
});

test('deleted files and renames remain accounted for', async t => {
  const root = await fixture(t);
  await rename(path.join(root, 'logic.ts'), path.join(root, 'renamed.ts'));
  const snapshot = await snapshotRepository(root);
  assert.deepEqual(snapshot.changes.map(c => c.file), ['logic.ts', 'renamed.ts']);
  assert.equal(snapshot.changes[0].newLines, 0);
  assert.equal(snapshot.changes[1].oldLines, 0);
});

test('guide artifacts do not become their own review changes', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'agr.json'), '{}');
  await writeFile(path.join(root, 'agr.snapshot.json'), '{}');
  assert.equal((await snapshotRepository(root)).changes.length, 0);
});

test('unborn repositories include additions and empty files', async t => {
  const root = await fixture(t, false);
  await writeFile(path.join(root, 'empty'), '');
  const snapshot = await snapshotRepository(root);
  assert.equal(snapshot.base, null);
  assert.equal(snapshot.changes.length, 2);
});

test('file mode changes remain visible alongside text changes', async t => {
  const root = await fixture(t);
  await chmod(path.join(root, 'logic.ts'), 0o755);
  await writeFile(path.join(root, 'logic.ts'), 'changed\n');
  const snapshot = await snapshotRepository(root);
  assert.ok(snapshot.changes.some(c => c.kind === 'metadata'));
  assert.ok(snapshot.changes.some(c => c.kind === 'text'));
});

test('symlinks are represented without reading their targets; path traversal is rejected', async t => {
  const root = await fixture(t);
  await symlink('/etc/passwd', path.join(root, 'link'));
  const snapshot = await snapshotRepository(root);
  assert.ok(snapshot.changes[0].patch.includes('/etc/passwd'));
  assert.ok(!snapshot.changes[0].patch.includes('root:'));
  await assert.rejects(safePath(root, '../outside'));
  await assert.rejects(safePath(root, '/etc/passwd'));
});

test('changed explanation and base invalidate approvals; coverage rejects old bases', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'new'), 'value\n');
  const snapshot = await snapshotRepository(root);
  const g = guide(snapshot.base, snapshot.changes.map(c => c.id));
  const step = g.groups[0].steps[0];
  step.review = { status: 'reviewed', fingerprint: stepFingerprint(step, snapshot) };
  step.note = 'Different explanation.';
  assert.equal(stepState(step, snapshot, g.base), 'stale');
  assert.equal(stepState(step, snapshot, null), 'stale');
  assert.equal(validateCoverage({ ...g, base: null }, snapshot).missing.length, 1);
});

test('schema validation rejects duplicate IDs, malformed refs, and bad state', () => {
  const g = guide(null, ['c_' + 'a'.repeat(64)]);
  assert.equal(parseGuide(JSON.stringify(g)).title, 'Feature');
  g.groups[0].steps[0].id = 'feature';
  assert.throws(() => parseGuide(JSON.stringify(g)), /duplicate/);
  g.groups[0].steps[0].id = 'valid';
  g.groups[0].steps[0].changes = ['../../file'];
  assert.throws(() => parseGuide(JSON.stringify(g)), /snapshot change IDs/);
});

test('one added hunk can be split into sections, with coverage for the remaining lines', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'new.ts'), 'one\ntwo\nthree\nfour\n');
  const snapshot = await snapshotRepository(root);
  const change = snapshot.changes[0];
  const g = guide(snapshot.base, [change.id]);
  const first = g.groups[0].steps[0];
  first.selections = { [change.id]: { modified: { start: 1, end: 2 } } };
  const remaining = uncoveredChanges(g, snapshot);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].newStart, 3);
  assert.equal(remaining[0].newLines, 2);
  const second = { ...first, id: 'second-part', selections: { [change.id]: { modified: { start: 3, end: 4 } } } };
  g.groups.push({ id: 'another-concern', title: 'Another concern', steps: [second] });
  assert.equal(selectedChanges(second, snapshot)[0].newStart, 3);
  assert.equal(uncoveredChanges(g, snapshot).length, 0);
  assert.equal(validateCoverage(parseGuide(JSON.stringify(g)), snapshot).invalidSelections.length, 0);
  first.review = { status: 'reviewed', fingerprint: stepFingerprint(first, snapshot) };
  assert.equal(stepState(first, snapshot, g.base), 'reviewed');
  assert.equal(stepState(second, snapshot, g.base), 'pending');
  first.selections[change.id].modified!.end = 3;
  assert.equal(stepState(first, snapshot, g.base), 'stale');
});

test('replacement ranges must cover removals too; out-of-bounds selections fail validation', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'logic.ts'), 'replacement\n');
  const snapshot = await snapshotRepository(root);
  const change = snapshot.changes[0];
  const g = guide(snapshot.base, [change.id]);
  const step = g.groups[0].steps[0];
  step.selections = { [change.id]: { modified: { start: 1, end: 1 } } };
  assert.equal(uncoveredChanges(g, snapshot)[0].oldLines, change.oldLines);
  step.selections[change.id].modified!.end = 100;
  assert.deepEqual(validateCoverage(g, snapshot).invalidSelections, [step.id]);
  assert.equal(stepState(step, snapshot, g.base), 'stale');
});

test('opening a step can validate only its files without changing hunk identities', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'first.ts'), 'first\n');
  await writeFile(path.join(root, 'other.ts'), 'other\n');
  const all = await snapshotRepository(root);
  const focused = await snapshotRepository(root, ['first.ts']);
  assert.deepEqual(focused.changes, all.changes.filter(c => c.file === 'first.ts'));
  await writeFile(path.join(root, 'other.ts'), Buffer.alloc(9 * 1024 * 1024));
  assert.deepEqual((await snapshotRepository(root, ['first.ts'])).changes, focused.changes, 'unrelated files are not read');
  await writeFile(path.join(root, 'first.ts'), 'changed\n');
  assert.notEqual((await snapshotRepository(root, ['first.ts'])).changes[0].id, focused.changes[0].id, 'selected files are still revalidated');
});
