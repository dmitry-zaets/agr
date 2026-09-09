import path from 'node:path';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { Guide, parseGuide } from './model';

export interface ReviewFile { file: string; guide?: Guide; error?: string }
export const isReviewArtifact = (file: string): boolean => file === '.agr' || file.startsWith('.agr/');

export async function reviewPath(root: string, file: string): Promise<string> {
  if (path.basename(file) !== file || !file.endsWith('.json') || file.startsWith('.')) throw new Error('Choose a JSON review directly inside .agr/.');
  const directory = path.join(root, '.agr');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('.agr must be a directory inside the repository, not a symbolic link.');
  const target = path.join(directory, file);
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Review files must be regular files, not symbolic links.');
  return target;
}
export async function listReviews(root: string): Promise<ReviewFile[]> {
  let entries;
  try {
    const directory = path.join(root, '.agr');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('.agr must be a regular directory.');
    entries = await readdir(directory);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(entries.filter(file => file.endsWith('.json') && !file.startsWith('.')).sort().map(async file => {
    try { return { file, guide: parseGuide(await readFile(await reviewPath(root, file), 'utf8')) }; }
    catch (error) { return { file, error: (error as Error).message }; }
  }));
}
