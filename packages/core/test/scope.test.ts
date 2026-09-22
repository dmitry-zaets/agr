import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, head } from '../src/git';
import { isAddedFile, changeContent, snapshotScope, snapshotForGuide } from '../src/scope';
import { Guide, parseGuide, parseScope, stepFingerprint, stepState, validateCoverage } from '../src/model';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agr-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-qb', 'main']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  await writeFile(path.join(root, 'file.ts'), 'base\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'base']);
  return root;
}

test('staged and unstaged comparisons use the index as the correct side', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file.ts'), 'staged\n'); await git(root, ['add', '.']);
  await writeFile(path.join(root, 'file.ts'), 'working\n');
  await writeFile(path.join(root, 'untracked.ts'), 'new\n');
  const snapshot = await snapshotScope(root, { comparisons: [{ id: 'staged', kind: 'staged' }, { id: 'unstaged', kind: 'unstaged' }] });
  const staged = snapshot.changes.find(c => c.comparisonId === 'staged')!;
  const unstaged = snapshot.changes.find(c => c.comparisonId === 'unstaged' && c.file === 'file.ts')!;
  assert.equal(await changeContent(root, snapshot, staged, 'original'), 'base\n');
  assert.equal(await changeContent(root, snapshot, staged, 'modified'), 'staged\n');
  assert.equal(await changeContent(root, snapshot, unstaged, 'original'), 'staged\n');
  assert.equal(await changeContent(root, snapshot, unstaged, 'modified'), 'working\n');
  assert.ok(snapshot.changes.some(c => c.file === 'untracked.ts' && c.comparisonId === 'unstaged'));
  assert.ok(!snapshot.changes.some(c => c.file === 'untracked.ts' && c.comparisonId === 'staged'));
  assert.notEqual(staged.id, unstaged.id);
});

test('committed reviews read pinned objects even when the worktree is dirty', async t => {
  const root = await fixture(t);
  const base = (await head(root))!;
  await writeFile(path.join(root, 'file.ts'), 'committed\n'); await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'feature']);
  const snapshot = await snapshotScope(root, { comparisons: [{ id: 'pr', title: 'PR #42', kind: 'revisions', base, head: 'HEAD' }] });
  assert.equal(snapshot.scope!.comparisons[0].head, await head(root));
  await writeFile(path.join(root, 'file.ts'), 'unrelated working edit\n');
  const pinned = await snapshotScope(root, snapshot.scope!);
  assert.deepEqual(pinned.changes, snapshot.changes);
  assert.equal(await changeContent(root, pinned, pinned.changes[0], 'modified'), 'committed\n');
  assert.equal(await changeContent(root, pinned, pinned.changes[0], 'original'), 'base\n');
});

test('merge-base branch comparison excludes changes that only landed on the base branch', async t => {
  const root = await fixture(t);
  await git(root, ['branch', 'feature']);
  await writeFile(path.join(root, 'main-only'), 'main\n'); await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'main advances']);
  await git(root, ['checkout', '-q', 'feature']);
  await writeFile(path.join(root, 'feature-only'), 'feature\n'); await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'feature']);
  const base = (await git(root, ['merge-base', 'main', 'feature'])).trim();
  const snapshot = await snapshotScope(root, { comparisons: [{ id: 'branch', kind: 'revisions', base, head: 'feature' }] });
  assert.deepEqual(snapshot.changes.map(c => c.file), ['feature-only']);
});

test('index additions remain reviewable after the corresponding working file is removed', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'added.ts'), 'indexed\n'); await git(root, ['add', '.']);
  await rm(path.join(root, 'added.ts'));
  const staged = await snapshotScope(root, { comparisons: [{ id: 'stage', kind: 'staged' }] });
  assert.equal(await changeContent(root, staged, staged.changes[0], 'modified'), 'indexed\n');
  const unstaged = await snapshotScope(root, { comparisons: [{ id: 'work', kind: 'unstaged' }] });
  assert.equal(unstaged.changes[0].newLines, 0);
});

test('path selection and untracked policy define explicit coverage boundaries', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file.ts'), 'changed\n');
  await writeFile(path.join(root, 'unrelated.ts'), 'new\n');
  const onlyTracked = await snapshotScope(root, { comparisons: [{ id: 'work', kind: 'working-tree', includeUntracked: false }] });
  assert.deepEqual(onlyTracked.changes.map(c => c.file), ['file.ts']);
  const selected = await snapshotScope(root, { comparisons: [{ id: 'selected', kind: 'working-tree', paths: ['unrelated.ts'] }] });
  assert.deepEqual(selected.changes.map(c => c.file), ['unrelated.ts']);
});

test('scoped guide validates and approval cannot transfer to a different comparison', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file.ts'), 'change\n'); await git(root, ['add', '.']);
  const snapshot = await snapshotScope(root, { comparisons: [{ id: 'stage', kind: 'staged' }] });
  const guide: Guide = { version: 1, title: 'Staged', base: snapshot.base, comparison: 'scoped', scope: snapshot.scope,
    groups: [{ id: 'group', title: 'Change', steps: [{ id: 'step', title: 'Edit', note: 'Read it.', changes: snapshot.changes.map(c => c.id) }] }] };
  assert.deepEqual(validateCoverage(parseGuide(JSON.stringify(guide)), await snapshotForGuide(root, guide)), { missing: [], unknown: [], invalidSelections: [], invalidComments: [], multiFileSteps: [], baseMatches: true });
  const step = guide.groups[0].steps[0];
  step.review = { status: 'reviewed', fingerprint: stepFingerprint(step, snapshot) };
  assert.equal(stepState(step, snapshot, guide.base), 'reviewed');
  const other = await snapshotScope(root, { comparisons: [{ id: 'working', kind: 'working-tree' }] });
  assert.equal(stepState(step, other, guide.base), 'stale');
});

test('staged binary and mode changes do not use unstaged bytes or modes', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'asset'), Buffer.from([0, 1]));
  await chmod(path.join(root, 'file.ts'), 0o755); await git(root, ['add', '.']);
  const before = await snapshotScope(root, { comparisons: [{ id: 'stage', kind: 'staged' }] });
  assert.ok(before.changes.some(c => c.kind === 'binary'));
  assert.ok(before.changes.some(c => c.kind === 'metadata'));
  await writeFile(path.join(root, 'asset'), Buffer.from([0, 2]));
  const after = await snapshotScope(root, before.scope!);
  assert.deepEqual(after.changes, before.changes);
});

test('empty repositories support staged and working scopes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agr-unborn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await writeFile(path.join(root, 'new'), 'new\n'); await git(root, ['add', '.']);
  for (const kind of ['staged', 'working-tree'] as const) {
    const snapshot = await snapshotScope(root, { comparisons: [{ id: kind, kind }] });
    assert.equal(snapshot.changes.length, 1);
    assert.equal(snapshot.scope!.comparisons[0].base, null);
  }
});

test('invalid scope combinations are rejected before Git runs', () => {
  assert.throws(() => parseScope({ comparisons: [{ id: 'bad', kind: 'staged', includeUntracked: true }] }), /untracked/i);
  assert.throws(() => parseScope({ comparisons: [{ id: 'bad', kind: 'revisions', head: 'HEAD' }] }), /base/);
  assert.throws(() => parseScope({ comparisons: [{ id: 'bad', kind: 'working-tree', paths: ['../outside'] }] }), /paths/);
});

test('an explicit empty staged baseline includes the whole index even when HEAD exists', async t => {
  const root = await fixture(t);
  const snapshot = await snapshotScope(root, { comparisons: [{ id: 'all', kind: 'staged', base: null }] });
  assert.deepEqual(snapshot.changes.map(c => c.file), ['file.ts']);
  assert.equal(snapshot.changes[0].oldLines, 0);
  assert.equal(await changeContent(root, snapshot, snapshot.changes[0], 'original'), '');
});

test('default local comparisons follow HEAD and invalidate after committing', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file.ts'), 'staged\n'); await git(root, ['add', '.']);
  const before = await snapshotScope(root, { comparisons: [{ id: 'stage', kind: 'staged' }] });
  assert.equal(before.scope!.comparisons[0].baseRef, 'HEAD');
  await git(root, ['commit', '-qm', 'commit staged change']);
  const after = await snapshotScope(root, before.scope!);
  assert.equal(after.changes.length, 0);
  assert.notEqual(after.base, before.base);
});

test('combined working scope preserves new-file identity when only staging changes', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'new.ts'), 'new\n');
  const before = await snapshotScope(root, { comparisons: [{ id: 'local', kind: 'working-tree' }] });
  await git(root, ['add', 'new.ts']);
  assert.deepEqual((await snapshotScope(root, before.scope!)).changes, before.changes);
});

test('added file detection distinguishes empty existing files and comparison baselines', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'empty.ts'), '');
  await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'empty baseline']);
  const base = (await head(root))!;
  await writeFile(path.join(root, 'empty.ts'), 'filled\n');
  await writeFile(path.join(root, 'added.ts'), 'added\n');
  let snapshot = await snapshotScope(root, { comparisons: [{ id: 'work', kind: 'working-tree', includeUntracked: true }] });
  assert.equal(await isAddedFile(root, snapshot, snapshot.changes.find(c => c.file === 'empty.ts')!), false);
  assert.equal(await isAddedFile(root, snapshot, snapshot.changes.find(c => c.file === 'added.ts')!), true);
  await git(root, ['add', '.']);
  await writeFile(path.join(root, 'added.ts'), 'changed after staging\n');
  snapshot = await snapshotScope(root, { comparisons: [{ id: 'stage', kind: 'staged' }, { id: 'work', kind: 'unstaged' }] });
  assert.equal(await isAddedFile(root, snapshot, snapshot.changes.find(c => c.file === 'added.ts' && c.comparisonId === 'stage')!), true);
  assert.equal(await isAddedFile(root, snapshot, snapshot.changes.find(c => c.file === 'added.ts' && c.comparisonId === 'work')!), false);
  await git(root, ['commit', '-qm', 'addition']);
  snapshot = await snapshotScope(root, { comparisons: [{ id: 'pr', kind: 'revisions', base, head: 'HEAD' }] });
  assert.equal(await isAddedFile(root, snapshot, snapshot.changes.find(c => c.file === 'added.ts')!), true);
});
