import { isReviewArtifact } from './reviews';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { Change, Comparison, Guide, hash, parseScope, Scope, Snapshot } from './model';
import { baseContent, git, head, identifyChanges, parseHunks, repositoryRoot, safePath, snapshotRepository, workingContent } from './git';

const exec = promisify(execFile);
const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color'];

async function revision(root: string, ref: string): Promise<string> {
  return (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
}
export async function resolveScope(root: string, scope: Scope): Promise<Scope> {
  const comparisons: Comparison[] = [];
  for (const c of parseScope(scope).comparisons) {
    const next: Comparison = { id: c.id, kind: c.kind };
    if (c.title !== undefined) next.title = c.title;
    if (c.kind !== 'unstaged') {
      const followsHead = ['working-tree', 'staged'].includes(c.kind) && (c.baseRef === 'HEAD' || c.base === undefined || c.base === 'HEAD');
      next.base = followsHead ? await head(root) : c.base === null ? null : await revision(root, c.base!);
      if (followsHead) next.baseRef = 'HEAD';
    }
    if (c.kind === 'revisions') next.head = await revision(root, c.head!);
    if (['working-tree', 'unstaged'].includes(c.kind)) next.includeUntracked = c.includeUntracked ?? true;
    if (c.paths) next.paths = [...new Set(c.paths.map(p => p.replace(/\/$/, '')))].sort();
    comparisons.push(next);
  }
  return { comparisons };
}
function diffArgs(c: Comparison): string[] {
  if (c.kind === 'revisions') return [c.base!, c.head!];
  if (c.kind === 'staged') return ['--cached', ...(c.base ? [c.base] : [])];
  if (c.kind === 'working-tree') return c.base ? [c.base] : [];
  return [];
}
async function indexContent(root: string, file: string): Promise<Buffer> {
  const entry = await git(root, ['ls-files', '--stage', '-z', '--', file]);
  if (!entry) return Buffer.alloc(0);
  const match = /^(\d+) ([a-f0-9]+) 0\t/.exec(entry);
  if (!match) throw new Error(`Unmerged index entry: ${file}`);
  if (match[1] === '160000') return Buffer.from(`Subproject commit ${match[2]}\n`);
  return objectContent(root, match[2]);
}
async function objectContent(root: string, object: string): Promise<Buffer> {
  const result = await exec('git', ['cat-file', 'blob', object], { cwd: root, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  return result.stdout;
}
async function revisionContent(root: string, ref: string | null | undefined, file: string): Promise<Buffer> {
  if (!ref) return Buffer.alloc(0);
  const entry = await git(root, ['ls-tree', '-z', ref, '--', file]);
  if (!entry) return Buffer.alloc(0);
  const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t/.exec(entry);
  if (!match) throw new Error(`Cannot review non-file entry: ${file}`);
  if (match[1] === '160000') return Buffer.from(`Subproject commit ${match[2]}\n`);
  return objectContent(root, match[2]);
}
export async function comparisonContent(root: string, c: Comparison, file: string, side: 'original' | 'modified'): Promise<Buffer> {
  // Validate Git paths without depending on the current checkout's directories.
  if (!file || file.startsWith('/') || file.split('/').includes('..') || file.includes('\0')) throw new Error('Unsafe comparison path.');
  if (side === 'original') return c.kind === 'unstaged' ? indexContent(root, file) : revisionContent(root, c.base, file);
  if (c.kind === 'revisions') return revisionContent(root, c.head, file);
  if (c.kind === 'staged') return indexContent(root, file);
  return workingContent(root, file);
}
export async function changeContent(root: string, snapshot: Snapshot, change: Change, side: 'original' | 'modified'): Promise<string> {
  if (!snapshot.scope) return side === 'original' ? baseContent(root, snapshot.base, change.file) : (await workingContent(root, change.file)).toString('utf8');
  const c = snapshot.scope.comparisons.find(c => c.id === change.comparisonId);
  if (!c) throw new Error('Missing comparison for this change.');
  return (await comparisonContent(root, c, change.file, side)).toString('utf8');
}

export async function snapshotScope(cwd: string, input: Scope, selectedFiles?: readonly string[]): Promise<Snapshot> {
  const root = await repositoryRoot(cwd);
  const scope = await resolveScope(root, input);
  const usesIndex = scope.comparisons.some(c => c.kind !== 'revisions');
  const indexBefore = usesIndex ? await git(root, ['ls-files', '--stage', '-z']) : '';
  if (usesIndex && await git(root, ['ls-files', '--unmerged', '-z'])) throw new Error('Resolve merge conflicts before reviewing index or working-tree changes.');
  const changes: Change[] = [];
  for (const c of scope.comparisons) {
    const emptyBase = ['working-tree', 'staged'].includes(c.kind) && c.base === null;
    const names = await git(root, emptyBase ? ['ls-files', '-z'] : ['diff', ...diffFlags, ...diffArgs(c), '--name-only', '-z', '--']);
    const untracked = c.includeUntracked ? (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean) : [];
    const files = [...new Set([...names.split('\0').filter(Boolean), ...untracked])]
      .filter(file => !isReviewArtifact(file))
      .filter(file => !selectedFiles || selectedFiles.includes(file))
      .filter(file => !c.paths || c.paths.some(p => p === '.' || file === p || file.startsWith(p + '/'))).sort();
    const parts: Omit<Change, 'id'>[] = [];
    for (const file of files) {
      const newWorkingFile = c.kind === 'working-tree' && c.base && !(await git(root, ['ls-tree', '-z', c.base, '--', file]));
      const syntheticAddition = emptyBase || untracked.includes(file) || newWorkingFile;
      let patch = '';
      const bytes = await comparisonContent(root, c, file, 'modified');
      if (syntheticAddition) {
        let mode: string;
        if (c.kind === 'staged') {
          mode = (await git(root, ['ls-files', '--stage', '-z', '--', file])).split(' ')[0];
        } else {
          let stat;
          try { stat = await lstat(await safePath(root, file)); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
        }
        const text = bytes.toString('utf8');
        const lines = text ? text.split('\n') : [];
        if (text.endsWith('\n')) lines.pop();
        const binary = bytes.includes(0);
        parts.push({ file, kind: binary ? 'binary' : text ? 'text' : 'metadata', oldStart: 0, oldLines: 0,
          newStart: lines.length && !binary ? 1 : 0, newLines: binary ? 0 : lines.length,
          patch: `new file mode ${mode}\n` + (binary ? `content-sha256:${hash(bytes.toString('base64'))}` : lines.map(line => '+' + line + '\n').join('') + (text && !text.endsWith('\n') ? '\\ No newline at end of file\n' : '')) });
        continue;
      }
      patch = await git(root, ['diff', ...diffFlags, ...diffArgs(c), '--unified=0', '--', file]);
      if (!patch) continue;
      const hunks = parseHunks(file, patch);
      parts.push(...hunks);
      const modes = patch.split('\n').filter(line => /^(old mode|new mode) /.test(line)).join('\n');
      if (hunks.length && modes) parts.push({ file, kind: 'metadata', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, patch: modes });
      if (!hunks.length) {
        const binary = bytes.includes(0) || /^Binary files /m.test(patch);
        parts.push({ file, kind: binary ? 'binary' : 'metadata', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0,
          patch: patch + (binary ? `\ncontent-sha256:${hash(bytes.toString('base64'))}` : '') });
      }
    }
    changes.push(...identifyChanges(parts).map(change => ({ ...change, comparisonId: c.id, id: 'c_' + hash(JSON.stringify([c.id, change.id])) })));
  }
  if (usesIndex && indexBefore !== await git(root, ['ls-files', '--stage', '-z'])) throw new Error('The index changed during the scan. Refresh and try again.');
  const base = hash(JSON.stringify(scope));
  return { version: 1, root, comparison: 'scoped', scope, base, changes };
}
export async function snapshotForGuide(root: string, guide?: Guide, files?: readonly string[]): Promise<Snapshot> {
  return guide?.scope ? snapshotScope(root, guide.scope, files) : snapshotRepository(root, files);
}
export function scopeLabel(snapshot: Snapshot): string {
  if (!snapshot.scope) return 'Uncommitted changes';
  return snapshot.scope.comparisons.map(c => `${c.title ?? c.kind}${c.paths ? ` (${c.paths.join(', ')})` : ''}`).join(' + ');
}
