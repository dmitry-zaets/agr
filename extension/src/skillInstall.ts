import path from 'node:path';
import { cp, mkdir, lstat } from 'node:fs/promises';

export type InstallScope = 'repository' | 'global';
export function skillTargets(scope: InstallScope, root: string | undefined, home: string, claudeConfig?: string): string[] {
  if (scope === 'repository' && !root) throw new Error('Open a Git repository before installing repository skills.');
  return scope === 'repository'
    ? ['.agents', '.claude'].map(folder => path.join(root!, folder, 'skills', 'agr'))
    : [path.join(home, '.agents', 'skills', 'agr'), path.join(claudeConfig || path.join(home, '.claude'), 'skills', 'agr')];
}
export async function installSkills(source: string, targets: string[]): Promise<void> {
  // Check every destination first, so an existing copy never causes a partial upgrade.
  for (const target of targets) {
    try { await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error(`${target} already exists. Move it aside before installing a new copy. Local skills can also take precedence over global skills.`);
  }
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  }
}
