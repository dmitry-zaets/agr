import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { skillTargets, installSkills } from '../../../extension/src/skillInstall';

test('global and repository skills use independent destinations and preserve existing files', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agr-install-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source'), home = path.join(temp, 'home'), root = path.join(temp, 'repo');
  await mkdir(source); await writeFile(path.join(source, 'SKILL.md'), 'AGR fixture');
  const global = skillTargets('global', undefined, home);
  assert.deepEqual(global, [path.join(home, '.agents/skills/agr'), path.join(home, '.claude/skills/agr')]);
  await installSkills(source, global);
  for (const target of global) assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), 'AGR fixture');
  const local = skillTargets('repository', root, home);
  await installSkills(source, local);
  for (const target of local) assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), 'AGR fixture');
  assert.throws(() => skillTargets('repository', undefined, home), /Open a Git repository/);
  assert.equal(skillTargets('global', undefined, home, path.join(temp, 'custom'))[1], path.join(temp, 'custom/skills/agr'));
  await writeFile(path.join(local[1], 'SKILL.md'), 'customized');
  const unused = path.join(temp, 'untouched');
  await assert.rejects(installSkills(source, [unused, local[1]]), /already exists/);
  await assert.rejects(access(unused));
  assert.equal(await readFile(path.join(local[1], 'SKILL.md'), 'utf8'), 'customized');
});
