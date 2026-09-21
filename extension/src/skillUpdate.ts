import path from 'node:path';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';

export async function skillDigest(directory: string): Promise<string | undefined> {
  let stat;
  try { stat = await lstat(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Update this linked or non-directory skill manually: ${directory}`);
  const hash = createHash('sha256');
  async function visit(folder: string): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      const file = path.join(folder, name), entry = await lstat(file);
      if (entry.isSymbolicLink()) throw new Error(`Update this skill manually because it contains a symbolic link: ${directory}`);
      hash.update(JSON.stringify([path.relative(directory, file), entry.isDirectory() ? 'directory' : 'file']));
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) hash.update(await readFile(file));
      else throw new Error(`Unsupported file in skill: ${file}`);
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

export interface SkillUpdate { target: string; digest: string }
export async function outdatedSkills(source: string, targets: string[]): Promise<{ digest: string; updates: SkillUpdate[]; skipped: string[] }> {
  const digest = await skillDigest(source);
  if (!digest) throw new Error('Bundled AGR skill is missing. Reinstall the extension.');
  const updates: SkillUpdate[] = [], skipped: string[] = [];
  for (const target of [...new Set(targets)]) {
    try {
      const installed = await skillDigest(target);
      if (installed && installed !== digest) updates.push({ target, digest: installed });
    } catch (error) { skipped.push((error as Error).message); }
  }
  return { digest, updates, skipped };
}

// Stage each complete replacement before moving the installed folder. Backups
// live outside skills/ so agents never discover the old skill as another skill.
export async function updateInstalledSkills(source: string, updates: SkillUpdate[]): Promise<string[]> {
  for (const { target, digest } of updates) {
    if (await skillDigest(target) !== digest) throw new Error(`Skill changed since the update was offered. Try again: ${target}`);
  }
  const backups: string[] = [];
  for (const { target, digest } of updates) {
    const backupRoot = path.join(path.dirname(path.dirname(target)), 'agr-skill-backups');
    await mkdir(backupRoot, { recursive: true });
    const staging = await mkdtemp(path.join(backupRoot, 'update-'));
    const next = path.join(staging, 'next'), previous = path.join(staging, 'previous');
    let moved = false;
    try {
      await cp(source, next, { recursive: true, force: false, errorOnExist: true });
      if (await skillDigest(target) !== digest) throw new Error(`Skill changed during update. Try again: ${target}`);
      await rename(target, previous); moved = true;
      await rename(next, target);
      backups.push(previous);
    } catch (error) {
      if (moved) await rename(previous, target);
      await rm(staging, { recursive: true, force: true });
      throw new Error(`${(error as Error).message}${backups.length ? ` Earlier copies were updated; backups: ${backups.join(', ')}` : ''}`);
    }
  }
  return backups;
}
