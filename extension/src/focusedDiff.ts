import { Change } from '../../packages/core/src/model';

export interface FocusedDiff { before: string; after: string; changes: Change[] }
const lines = (text: string): string[] => {
  if (!text) return [];
  const result = text.split('\n');
  if (text.endsWith('\n')) result.pop();
  return result;
};
const start = (c: Change, side: 'old' | 'new') => Math.max(0, c[`${side}Start`] - (c[`${side}Lines`] > 0 ? 1 : 0));

/** Read-only excerpts, never an applicable patch. Headers preserve source coordinates.
 * Context stops at every other hunk and never includes unselected changed lines.
 */
export function focusedDiff(before: string, after: string, selected: Change[], all: Change[], context = 3): FocusedDiff {
  const old = lines(before), next = lines(after);
  const left: string[] = [], right: string[] = [], changes: Change[] = [];
  for (const c of [...selected].sort((a, b) => a.newStart - b.newStart || a.oldStart - b.oldStart)) {
    if (c.kind !== 'text') {
      const header = '⋯ File metadata ⋯';
      left.push(header, ...lines(c.patch)); right.push(header, ...lines(c.patch));
      changes.push({ ...c, oldStart: left.length, newStart: right.length });
      continue;
    }
    const full = all.find(h => h.id === c.id);
    if (!full) throw new Error('The selected change is no longer available. Refresh the review.');
    const oldFrom = start(c, 'old'), newFrom = start(c, 'new');
    const oldEnd = oldFrom + c.oldLines, newEnd = newFrom + c.newLines;
    const fullOld = start(full, 'old'), fullNew = start(full, 'new');
    const atStart = (!full.oldLines || c.oldLines > 0 && oldFrom === fullOld) && (!full.newLines || c.newLines > 0 && newFrom === fullNew);
    const atEnd = (!full.oldLines || c.oldLines > 0 && oldEnd === fullOld + full.oldLines) && (!full.newLines || c.newLines > 0 && newEnd === fullNew + full.newLines);
    const neighbours = all.filter(h => h.id !== c.id && h.kind === 'text');
    const previousOld = Math.max(0, ...neighbours.filter(h => start(h, 'old') + h.oldLines <= fullOld).map(h => start(h, 'old') + h.oldLines));
    const previousNew = Math.max(0, ...neighbours.filter(h => start(h, 'new') + h.newLines <= fullNew).map(h => start(h, 'new') + h.newLines));
    const followingOld = Math.min(old.length, ...neighbours.filter(h => start(h, 'old') >= fullOld + full.oldLines).map(h => start(h, 'old')));
    const followingNew = Math.min(next.length, ...neighbours.filter(h => start(h, 'new') >= fullNew + full.newLines).map(h => start(h, 'new')));
    const prefix = atStart ? Math.max(0, Math.min(context, oldFrom - previousOld, newFrom - previousNew)) : 0;
    const suffix = atEnd ? Math.max(0, Math.min(context, followingOld - oldEnd, followingNew - newEnd)) : 0;
    const location = (from: number, count: number) => count ? `L${from + 1}–${from + count}` : `after L${from}`;
    const header = `⋯ Original ${location(oldFrom - prefix, c.oldLines + prefix + suffix)} · Modified ${location(newFrom - prefix, c.newLines + prefix + suffix)} ⋯`;
    left.push(header); right.push(header);
    const oldStart = left.length + prefix + 1, newStart = right.length + prefix + 1;
    left.push(...old.slice(oldFrom - prefix, oldEnd + suffix));
    right.push(...next.slice(newFrom - prefix, newEnd + suffix));
    if (oldEnd + suffix === old.length && c.oldLines + prefix + suffix > 0 && before && !before.endsWith('\n')) left.push('\\ No newline at end of file');
    if (newEnd + suffix === next.length && c.newLines + prefix + suffix > 0 && after && !after.endsWith('\n')) right.push('\\ No newline at end of file');
    changes.push({ ...c, oldStart, newStart });
  }
  return { before: left.join('\n') + '\n', after: right.join('\n') + '\n', changes };
}
