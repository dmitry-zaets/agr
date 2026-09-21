import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { listReviews, reviewPath } from '../src/reviews';
import { git, snapshotRepository, head } from '../src/git';
import { snapshotScope } from '../src/scope';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agr-reviews-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  await writeFile(path.join(root, 'file.ts'), 'base\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'initial']);
  await mkdir(path.join(root, '.agr', '.cache'), { recursive: true });
  return root;
}
const guide = { version: 1, title: 'Review', comparison: 'head-to-working-tree', base: null, groups: [] };

test('discovers named reviews, preserves invalid entries, and ignores root and cache files', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'agr.json'), JSON.stringify(guide));
  await writeFile(path.join(root, '.agr', '.cache', 'snapshot.json'), '{}');
  await writeFile(path.join(root, '.agr', 'b.json'), JSON.stringify(guide));
  await writeFile(path.join(root, '.agr', 'a.json'), '{');
  const reviews = await listReviews(root);
  assert.deepEqual(reviews.map(r => r.file), ['a.json', 'b.json']);
  assert.ok(reviews[0].error);
  assert.equal(reviews[1].guide?.title, 'Review');
  await assert.rejects(reviewPath(root, '../agr.json'));
  await symlink(path.join(root, 'agr.json'), path.join(root, '.agr', 'link.json'));
  assert.ok((await listReviews(root)).find(r => r.file === 'link.json')?.error);
});

test('excludes the entire review folder from all comparison kinds, even when tracked', async t => {
  const root = await fixture(t);
  const base = (await head(root))!;
  await writeFile(path.join(root, '.agr', 'a.json'), JSON.stringify(guide));
  await writeFile(path.join(root, '.agr', '.cache', 'snapshot.json'), '{}');
  await writeFile(path.join(root, 'file.ts'), 'committed\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'feature']);
  const tip = (await head(root))!;
  await writeFile(path.join(root, '.agr', 'a.json'), '{}');
  await writeFile(path.join(root, 'file.ts'), 'staged\n'); await git(root, ['add', '.']);
  await writeFile(path.join(root, '.agr', 'a.json'), '{"changed":true}');
  await writeFile(path.join(root, 'file.ts'), 'working\n');
  const snapshots = [await snapshotRepository(root), await snapshotScope(root, { comparisons: [
    { id: 'pr', kind: 'revisions', base, head: tip },
    { id: 'staged', kind: 'staged' }, { id: 'unstaged', kind: 'unstaged' }, { id: 'working', kind: 'working-tree' }
  ] })];
  for (const snapshot of snapshots) {
    assert.ok(snapshot.changes.length);
    assert.ok(snapshot.changes.every(change => change.file === 'file.ts'));
  }
});

test('CLI validates a selected review independently or reports all review failures', async t => {
  const root = await fixture(t);
  const cli = path.resolve('packages/core/src/cli.ts');
  const args = ['--import', 'tsx', cli, 'validate', root];
  const valid = { ...guide, base: await head(root) };
  await writeFile(path.join(root, '.agr', 'good.json'), JSON.stringify(valid));
  await writeFile(path.join(root, '.agr', 'bad.json'), '{');
  const one = JSON.parse(execFileSync(process.execPath, [...args, 'good.json'], { encoding: 'utf8' }));
  assert.equal(one.reviews.length, 1);
  assert.equal(one.reviews[0].baseMatches, true);
  const all = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(all.status, 1);
  assert.equal(JSON.parse(all.stdout).reviews.length, 2);
  const outside = spawnSync(process.execPath, [...args, '../agr.json'], { encoding: 'utf8' });
  assert.equal(outside.status, 1);
});

test('CLI rejects steps spanning files and accepts their split replacement', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'file.ts'), 'changed\n');
  await writeFile(path.join(root, 'second.ts'), 'added\n');
  const snapshot = await snapshotRepository(root);
  const { splitFileSteps } = await import('../src/model');
  const multi = { ...guide, base: snapshot.base, groups: [{ id: 'group', title: 'Group', steps: [{ id: 'both', title: 'Both files', note: 'Review both', changes: snapshot.changes.map(c => c.id) }] }] };
  const file = path.join(root, '.agr', 'multi.json');
  await writeFile(file, JSON.stringify(multi));
  const args = ['--import', 'tsx', path.resolve('packages/core/src/cli.ts'), 'validate', root, 'multi.json'];
  const invalid = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout).reviews[0].multiFileSteps, ['both']);
  await writeFile(file, JSON.stringify(splitFileSteps(multi as import('../src/model').Guide, snapshot)));
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
});
