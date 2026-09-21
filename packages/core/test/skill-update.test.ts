import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { outdatedSkills, skillDigest, updateInstalledSkills } from '../../../extension/src/skillUpdate';
import { installSkills, skillTargets } from '../../../extension/src/skillInstall';
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agr-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'bundle');
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), 'new skill');
  await writeFile(path.join(source, 'scripts', 'agr.cjs'), 'new helper');
  return { root, source, targets: skillTargets('global', undefined, root) };
}
test('skill updates detect changes while ignoring missing and identical copies', async t => {
  const { source, targets } = await fixture(t);
  assert.equal((await outdatedSkills(source, targets)).updates.length, 0);
  await installSkills(source, targets);
  assert.equal((await outdatedSkills(source, targets)).updates.length, 0);
  await writeFile(path.join(targets[0], 'SKILL.md'), 'old skill');
  const result = await outdatedSkills(source, targets);
  assert.equal(result.updates.length, 1); assert.equal(result.updates[0].target, targets[0]);
  assert.equal(result.digest, await skillDigest(source));
});
test('updating replaces complete bundles and backs up customizations outside skills', async t => {
  const { source, targets } = await fixture(t);
  await installSkills(source, targets);
  for (const target of targets) {
    await writeFile(path.join(target, 'SKILL.md'), 'customized old skill');
    await writeFile(path.join(target, 'custom.txt'), 'preserve me');
  }
  const { updates } = await outdatedSkills(source, targets);
  const backups = await updateInstalledSkills(source, updates);
  assert.equal(backups.length, 2);
  for (const [i, backup] of backups.entries()) {
    assert.ok(!backup.startsWith(path.dirname(targets[i]) + path.sep));
    assert.equal(await readFile(path.join(backup, 'SKILL.md'), 'utf8'), 'customized old skill');
    assert.equal(await readFile(path.join(backup, 'custom.txt'), 'utf8'), 'preserve me');
    assert.equal(await skillDigest(targets[i]), await skillDigest(source));
    await assert.rejects(access(path.join(targets[i], 'custom.txt')));
  }
  assert.equal((await outdatedSkills(source, targets)).updates.length, 0);
});
test('updates reject intervening edits before changing any installed copy', async t => {
  const { source, targets } = await fixture(t); await installSkills(source, targets);
  for (const target of targets) await writeFile(path.join(target, 'SKILL.md'), 'old skill');
  const { updates } = await outdatedSkills(source, targets);
  await writeFile(path.join(targets[1], 'SKILL.md'), 'edited after prompt');
  await assert.rejects(updateInstalledSkills(source, updates), /changed since/);
  assert.equal(await readFile(path.join(targets[0], 'SKILL.md'), 'utf8'), 'old skill');
  assert.equal(await readFile(path.join(targets[1], 'SKILL.md'), 'utf8'), 'edited after prompt');
});
test('linked skills are skipped and never replaced', async t => {
  const { root, source, targets } = await fixture(t);
  await mkdir(path.dirname(targets[0]), { recursive: true }); await symlink(source, targets[0]);
  const result = await outdatedSkills(source, targets);
  assert.equal(result.updates.length, 0); assert.equal(result.skipped.length, 1);
  await assert.rejects(skillDigest(targets[0]), /linked/);
  assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), 'new skill');
});
