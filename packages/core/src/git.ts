import { isReviewArtifact } from './reviews';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Change, hash, Snapshot } from './model';

const exec = promisify(execFile);
export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['--no-pager', ...args], {
    cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 30000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' }
  });
  return stdout;
}
export async function repositoryRoot(cwd: string): Promise<string> {
  const canonical = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const relative = (await git(cwd, ['rev-parse', '--show-cdup'])).trim();
  const logical = path.resolve(cwd, relative);
  return await realpath(logical) === await realpath(canonical) ? logical : canonical;
}
export async function head(root: string): Promise<string | null> {
  try { return (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch { await git(root, ['rev-parse', '--git-dir']); return null; }
}
export async function safePath(root: string, file: string): Promise<string> {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || file.includes('\0')) throw new Error('Unsafe repository path.');
  const absolute = path.resolve(root, file);
  // Validate the parent so deletions and symlinks themselves are representable.
  let parent = path.dirname(absolute);
  while (true) {
    try {
      const actual = await realpath(parent);
      const canonical = await realpath(root);
      if (actual !== canonical && !actual.startsWith(canonical + path.sep)) throw new Error('Path leaves the repository.');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      parent = path.dirname(parent);
    }
  }
  return absolute;
}
export async function workingContent(root: string, file: string): Promise<Buffer> {
  const absolute = await safePath(root, file);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return Buffer.from(await readlink(absolute));
    if (!stat.isFile()) return Buffer.from('[Directory or submodule]');
    if (stat.size > 8 * 1024 * 1024) throw new Error(`${file} exceeds the 8 MB per-file limit.`);
    return await readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}
export async function baseContent(root: string, base: string | null, file: string): Promise<string> {
  await safePath(root, file);
  if (!base) return '';
  try { return await git(root, ['show', `${base}:${file}`]); }
  catch (error) {
    // Missing in HEAD is expected for added files; other failures must surface.
    const exists = await git(root, ['ls-tree', '-z', base, '--', file]);
    if (!exists) return '';
    throw error;
  }
}

export function parseHunks(file: string, patch: string): Omit<Change, 'id'>[] {
  const lines = patch.split('\n');
  const result: Omit<Change, 'id'>[] = [];
  let current: Omit<Change, 'id'> | undefined;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      current = {
        file, kind: 'text', oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]), newLines: Number(match[4] ?? 1), patch: ''
      };
      result.push(current);
    } else if (current && /^[+\-\\ ]/.test(line)) current.patch += line + '\n';
  }
  return result;
}
export function identifyChanges(changes: Omit<Change, 'id'>[]): Change[] {
  const keys = changes.map(c => hash(JSON.stringify([c.file, c.kind, c.patch])));
  const counts = new Map<string, number>();
  keys.forEach(key => counts.set(key, (counts.get(key) ?? 0) + 1));
  return changes.map((c, i) => ({
    ...c,
    // Identical patches in one file are ambiguous. Include locations, conservatively
    // invalidating them on shifts rather than attaching approval to the wrong change.
    id: 'c_' + hash(JSON.stringify([keys[i], counts.get(keys[i]) === 1 ? null : [c.oldStart, c.newStart]]))
  }));
}
export async function snapshotRepository(cwd: string, selectedFiles?: readonly string[]): Promise<Snapshot> {
  const root = await repositoryRoot(cwd);
  const base = await head(root);
  const tracked = await git(root, base
    ? ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--']
    : ['ls-files', '-z']);
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const unmerged = await git(root, ['ls-files', '--unmerged', '-z']);
  if (unmerged) throw new Error('Resolve merge conflicts before generating a review guide.');
  const files = [...new Set((tracked + untracked).split('\0').filter(Boolean))]
    .filter(f => !isReviewArtifact(f))
    .filter(f => !selectedFiles || selectedFiles.includes(f)).sort();
  const changes: Omit<Change, 'id'>[] = [];
  for (const file of files) {
    const bytes = await workingContent(root, file);
    const entry = base ? await git(root, ['ls-tree', '-z', base, '--', file]) : '';
    if (!entry) {
      const stat = await lstat(await safePath(root, file));
      const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111) ? '100755' : '100644';
      const binary = bytes.includes(0);
      const content = bytes.toString('utf8');
      const lines = content ? content.split('\n') : [];
      if (content.endsWith('\n')) lines.pop();
      const patch = lines.map(line => '+' + line + '\n').join('') + (content && !content.endsWith('\n') ? '\\ No newline at end of file\n' : '');
      changes.push({ file, kind: binary ? 'binary' : content ? 'text' : 'metadata',
        oldStart: 0, oldLines: 0, newStart: content && !binary ? 1 : 0, newLines: binary ? 0 : lines.length,
        patch: binary ? `new file mode ${mode}\ncontent-sha256:${hash(bytes.toString('base64'))}` : `new file mode ${mode}\n${patch}` });
      continue;
    }
    const patch = base ? await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=0', base, '--', file]) : '';
    const hunks = parseHunks(file, patch);
    if (hunks.length) {
      changes.push(...hunks);
      if (/^(old mode|new mode) /m.test(patch)) changes.push({file, kind:'metadata', oldStart:1, oldLines:0, newStart:1, newLines:0, patch: patch.split('\n').filter(l => /^(old mode|new mode) /.test(l)).join('\n')});
    } else if (patch || bytes.length || !base || untracked.split('\0').includes(file)) {
      const isNew = !patch;
      const binary = bytes.includes(0) || /^Binary files /m.test(patch);
      const text = bytes.toString('utf8');
      const lineCount = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
      changes.push({
        file, kind: binary ? 'binary' : isNew && bytes.length ? 'text' : 'metadata',
        oldStart: 0, oldLines: 0, newStart: lineCount ? 1 : 0, newLines: binary ? 0 : lineCount,
        patch: binary ? `${patch}\ncontent-sha256:${hash(bytes.toString('base64'))}` : isNew ? text.split('\n').map(l => '+' + l).join('\n') : patch
      });
    }
  }
  if (await head(root) !== base) throw new Error('HEAD changed during the scan. Refresh and try again.');
  return { version: 1, root, base, comparison: 'head-to-working-tree', changes: identifyChanges(changes) };
}
