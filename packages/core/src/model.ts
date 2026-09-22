import { createHash } from 'node:crypto';

export interface Comparison {
  id: string;
  title?: string;
  kind: 'working-tree' | 'staged' | 'unstaged' | 'revisions';
  base?: string | null;
  baseRef?: 'HEAD';
  head?: string;
  includeUntracked?: boolean;
  paths?: string[];
}
export interface Scope { comparisons: Comparison[] }

export interface Change {
  id: string;
  file: string;
  kind: 'text' | 'binary' | 'metadata';
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  patch: string;
  comparisonId?: string;
}
export interface Snapshot {
  version: 1;
  root: string;
  base: string | null;
  comparison: 'head-to-working-tree' | 'scoped';
  scope?: Scope;
  changes: Change[];
}
export interface Explanation { changeId: string; side: 'original' | 'modified'; start: number; end: number; note: string; title?: string }
export interface Step {
  comments?: Explanation[];
  file?: string;
  changeGroup?: { id: string; title: string };
  id: string;
  title: string;
  note: string;
  focus?: string;
  changes: string[];
  selections?: Record<string, { original?: { start: number; end: number }; modified?: { start: number; end: number } }>;
  optional?: boolean;
  review?: { status: 'pending' | 'reviewed'; fingerprint?: string; reviewedAt?: string };
}
export interface Guide {
  pullRequestUrl?: string;
  version: 1;
  title: string;
  summary?: string;
  comparison: 'head-to-working-tree' | 'scoped';
  scope?: Scope;
  base: string | null;
  groups: { id: string; title: string; steps: Step[] }[];
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const allSteps = (guide: Guide): Step[] => guide.groups.flatMap(g => g.steps);

export function parseScope(value: unknown): Scope {
  const scope = value as Scope;
  if (!scope || !Array.isArray(scope.comparisons) || !scope.comparisons.length) throw new Error('Scope needs at least one comparison.');
  const ids = new Set<string>();
  for (const c of scope.comparisons) {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(c.id) || ids.has(c.id)) throw new Error('Comparison IDs must be unique letters, numbers, underscores, or hyphens.');
    ids.add(c.id);
    if (!['working-tree', 'staged', 'unstaged', 'revisions'].includes(c.kind)) throw new Error(`Unknown comparison kind: ${c.kind}`);
    if (c.title !== undefined && typeof c.title !== 'string') throw new Error('Comparison title must be text.');
    if (c.base !== undefined && c.base !== null && (typeof c.base !== 'string' || !c.base.trim())) throw new Error('Invalid base revision.');
    if (c.head !== undefined && (typeof c.head !== 'string' || !c.head.trim())) throw new Error('Invalid head revision.');
    if (c.kind === 'revisions' && (!c.base || !c.head)) throw new Error('A revisions comparison needs base and head commits.');
    if (c.kind !== 'revisions' && c.head !== undefined) throw new Error('Only revisions comparisons accept head.');
    if (c.kind === 'unstaged' && c.base !== undefined) throw new Error('Unstaged comparisons always start from the index.');
    if (c.baseRef !== undefined && (c.baseRef !== 'HEAD' || !['working-tree', 'staged'].includes(c.kind))) throw new Error('baseRef is supported only for local comparisons following HEAD.');
    if (c.includeUntracked !== undefined && typeof c.includeUntracked !== 'boolean') throw new Error('includeUntracked must be boolean.');
    if (c.includeUntracked && !['working-tree', 'unstaged'].includes(c.kind)) throw new Error('Only working-tree and unstaged comparisons can include untracked files.');
    if (c.paths !== undefined && (!Array.isArray(c.paths) || !c.paths.length || c.paths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.includes('\0') || p.split('/').includes('..') || /[*?\[\]]/.test(p)))) throw new Error('paths must contain literal repository-relative files or directories, without traversal or glob patterns.');
  }
  return scope;
}

export function parseGuide(text: string): Guide {
  let g = JSON.parse(text);
  if (g?.version === 2) {
    const ids = new Set<string>();
    if (!Array.isArray(g.groups)) throw new Error('Invalid review guide: groups must be an array.');
    g = { ...g, version: 1, groups: g.groups.map((section: any) => {
      if (!section || !Array.isArray(section.changes) || section.steps !== undefined) throw new Error('Invalid review guide: sections need changes.');
      const steps = section.changes.flatMap((change: any) => {
        if (!change || typeof change.id !== 'string' || !change.id.trim() || ids.has(change.id) || typeof change.title !== 'string' || !change.title.trim() || !Array.isArray(change.files) || !change.files.length) throw new Error('Invalid review guide: changes need unique id, title, and files.');
        ids.add(change.id);
        return change.files.map((file: any) => {
          if (!file || typeof file.file !== 'string' || !file.file || file.file.startsWith('/') || file.file.includes('\\') || file.file.includes('\0') || file.file.split('/').includes('..')) throw new Error('Invalid review guide: each file needs a repository-relative path.');
          return { ...file, title: file.title ?? change.title, changeGroup: { id: change.id, title: change.title } };
        });
      });
      const { changes, ...rest } = section;
      return { ...rest, steps };
    }) };
    for (const section of g.groups) for (const entry of [section, ...section.steps]) {
      if (ids.has(entry.id)) throw new Error(`Invalid review guide: duplicate id ${entry.id}.`);
    }
  }
  const fail = (message: string): never => { throw new Error(`Invalid review guide: ${message}`); };
  const string = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!g || g.version !== 1 || !string(g.title) || !['head-to-working-tree', 'scoped'].includes(g.comparison)) {
    fail('expected version 1, title, and a supported comparison.');
  }
  if (g.pullRequestUrl !== undefined && (typeof g.pullRequestUrl !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(g.pullRequestUrl) || !Number.isSafeInteger(Number(g.pullRequestUrl.replace(/\/$/, '').split('/').pop())))) fail('pullRequestUrl must be a github.com PR URL.');
  if (g.comparison === 'scoped') parseScope(g.scope);
  else if (g.scope !== undefined) fail('scope requires comparison "scoped".');
  if (g.base !== null && (typeof g.base !== 'string' || !/^[a-f0-9]{40,64}$/.test(g.base))) fail('base must be a commit hash or null.');
  if (g.summary !== undefined && typeof g.summary !== 'string') fail('summary must be text.');
  if (!Array.isArray(g.groups)) fail('groups must be an array.');
  const ids = new Set<string>();
  for (const group of g.groups) {
    if (!group || !string(group.id) || !string(group.title) || !Array.isArray(group.steps)) fail('each group needs id, title, and steps.');
    if (ids.has(group.id)) fail(`duplicate id ${group.id}.`);
    ids.add(group.id);
    for (const step of group.steps) {
      if (!step || !string(step.id) || !string(step.title) || typeof step.note !== 'string') fail('each step needs id, title, and note.');
      if (ids.has(step.id)) fail(`duplicate id ${step.id}.`);
      ids.add(step.id);
      if (!Array.isArray(step.changes) || !step.changes.length || !step.changes.every((c: unknown) => typeof c === 'string' && /^c_[a-f0-9]{64}$/.test(c))) fail(`${step.id}: changes must contain snapshot change IDs.`);
      if (new Set(step.changes).size !== step.changes.length) fail(`${step.id}: duplicate changes.`);
      if (step.selections !== undefined) {
        if (!step.selections || typeof step.selections !== 'object' || Array.isArray(step.selections)) fail(`${step.id}: invalid selections.`);
        for (const [id, selection] of Object.entries(step.selections) as [string, any][]) {
          if (!step.changes.includes(id) || !selection || typeof selection !== 'object' || (!selection.original && !selection.modified)) fail(`${step.id}: selection must reference a change and at least one side.`);
          for (const range of [selection.original, selection.modified]) {
            if (range !== undefined && (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start)) fail(`${step.id}: selection offsets must be positive, inclusive ranges.`);
          }
        }
      }
      if (step.comments !== undefined) {
        if (!Array.isArray(step.comments)) fail(`${step.id}: comments must be an array.`);
        for (const comment of step.comments) {
          if (!comment || !step.changes.includes(comment.changeId) || !['original', 'modified'].includes(comment.side) || !Number.isSafeInteger(comment.start) || !Number.isSafeInteger(comment.end) || comment.start < 1 || comment.end < comment.start || !string(comment.note) || (comment.title !== undefined && !string(comment.title))) fail(`${step.id}: invalid comment anchor or text.`);
        }
      }
      if (step.file !== undefined && (typeof step.file !== 'string' || !step.file || step.file.startsWith('/') || step.file.includes('\\') || step.file.includes('\0') || step.file.split('/').includes('..'))) fail(`${step.id}: file must be repository-relative.`);
      if (step.changeGroup !== undefined && (!step.changeGroup || !string(step.changeGroup.id) || !string(step.changeGroup.title))) fail(`${step.id}: invalid change group.`);
      if (step.focus !== undefined && typeof step.focus !== 'string') fail(`${step.id}: focus must be text.`);
      if (step.optional !== undefined && typeof step.optional !== 'boolean') fail(`${step.id}: optional must be boolean.`);
      if (step.review !== undefined && (!step.review || !['pending', 'reviewed'].includes(step.review.status))) fail(`${step.id}: invalid review status.`);
      if (step.review?.fingerprint !== undefined && typeof step.review.fingerprint !== 'string') fail(`${step.id}: invalid fingerprint.`);
    }
  }
  return g as Guide;
}

// Review approval is tied to both the code and the explanation the user saw.
export function stepFingerprint(step: Step, snapshot: Snapshot): string {
  return hash(JSON.stringify([snapshot.base, step.id, step.title, step.note, step.focus, step.optional, ...(step.changeGroup ? [step.changeGroup.title, step.file] : []), [...step.changes].sort(), Object.entries(step.selections ?? {}).sort(([a], [b]) => a.localeCompare(b)), ...(step.comments?.length ? [step.comments] : [])]));
}
export function selectedChanges(step: Step, snapshot: Snapshot): Change[] {
  return step.changes.flatMap(id => {
    const change = snapshot.changes.find(c => c.id === id);
    if (!change || (step.file !== undefined && step.file !== change.file)) return [];
    const selection = step.selections?.[id];
    if (!selection) return [change];
    const { original, modified } = selection;
    if (change.kind !== 'text' || (original && original.end > change.oldLines) || (modified && modified.end > change.newLines)) return [];
    return [{ ...change,
      oldStart: original ? change.oldStart + original.start - 1 : change.oldStart,
      oldLines: original ? original.end - original.start + 1 : 0,
      newStart: modified ? change.newStart + modified.start - 1 : change.newStart,
      newLines: modified ? modified.end - modified.start + 1 : 0
    }];
  });
}
/** Resolve explanation offsets only against the referenced, unchanged hunk. */
export function explanationAnchors(step: Step, snapshot: Snapshot): (Explanation & { line: number; endLine: number })[] {
  return (step.comments ?? []).map(comment => {
    const change = snapshot.changes.find(c => c.id === comment.changeId);
    const count = change && (comment.side === 'original' ? change.oldLines : change.newLines);
    const selection = step.selections?.[comment.changeId];
    const range = selection?.[comment.side];
    if (!change || change.kind !== 'text' || (step.file && step.file !== change.file) || comment.end > count! || (selection && (!range || comment.start < range.start || comment.end > range.end))) throw new Error(`${step.id}: comment anchor is outside its reviewed hunk. Regenerate the guide.`);
    const first = comment.side === 'original' ? change.oldStart : change.newStart;
    return { ...comment, line: first + comment.start - 1, endLine: first + comment.end - 1 };
  });
}
export function stepState(step: Step, snapshot: Snapshot, guideBase: string | null): 'pending' | 'reviewed' | 'stale' {
  if (guideBase !== snapshot.base || selectedChanges(step, snapshot).length !== step.changes.length) return 'stale';
  try { explanationAnchors(step, snapshot); } catch { return 'stale'; }
  if (step.review?.status !== 'reviewed') return 'pending';
  return step.review.fingerprint === stepFingerprint(step, snapshot) ? 'reviewed' : 'stale';
}
export function uncoveredChanges(guide: Guide | undefined, snapshot: Snapshot): Change[] {
  const selected = guide?.base === snapshot.base ? allSteps(guide).flatMap(s => selectedChanges(s, snapshot)) : [];
  return snapshot.changes.flatMap(change => {
    const coverage = selected.filter(c => c.id === change.id);
    if (!coverage.length) return [change];
    if (change.kind !== 'text') return [];
    const missing: Change[] = [];
    for (const side of ['old', 'new'] as const) {
      const startKey = `${side}Start` as const;
      const linesKey = `${side}Lines` as const;
      let run = -1;
      for (let index = 0; index <= change[linesKey]; index++) {
        const line = change[startKey] + index;
        const uncovered = index < change[linesKey] && !coverage.some(c => line >= c[startKey] && line < c[startKey] + c[linesKey]);
        if (uncovered && run < 0) run = index;
        if (!uncovered && run >= 0) {
          missing.push({ ...change, oldLines: 0, newLines: 0, [startKey]: change[startKey] + run, [linesKey]: index - run });
          run = -1;
        }
      }
    }
    return missing;
  });
}

export function validateCoverage(guide: Guide, snapshot: Snapshot): { missing: string[]; unknown: string[]; invalidSelections: string[]; invalidComments: string[]; multiFileSteps: string[]; baseMatches: boolean } {
  const current = new Set(snapshot.changes.map(c => c.id));
  return {
    missing: uncoveredChanges(guide, snapshot).map(c => c.id),
    unknown: [...new Set(allSteps(guide).flatMap(s => s.changes).filter(id => !current.has(id)))],
    invalidSelections: allSteps(guide).filter(step => step.changes.every(id => current.has(id)) && selectedChanges(step, snapshot).length !== step.changes.length).map(step => step.id),
    invalidComments: allSteps(guide).filter(step => { try { explanationAnchors(step, snapshot); return false; } catch { return true; } }).map(step => step.id),
    multiFileSteps: allSteps(guide).filter(step => new Set(snapshot.changes.filter(c => step.changes.includes(c.id)).map(c => JSON.stringify([c.comparisonId, c.file]))).size > 1).map(step => step.id),
    baseMatches: guide.base === snapshot.base
  };
}

/** Split legacy steps by file and comparison without transferring stale approval. */
export function splitFileSteps(guide: Guide, snapshot: Snapshot): Guide {
  const current = new Map(snapshot.changes.map(c => [c.id, c]));
  const used = new Set([...guide.groups.map(g => g.id), ...allSteps(guide).map(s => s.id)]);
  let changed = false;
  const groups = guide.groups.map(group => ({ ...group, steps: group.steps.flatMap(step => {
    // Missing IDs cannot safely be assigned to a file. Keep them for regeneration.
    if (step.changes.some(id => !current.has(id))) return [step];
    const files = new Map<string, Change[]>();
    for (const id of step.changes) {
      const c = current.get(id)!;
      const key = JSON.stringify([c.comparisonId, c.file]);
      files.set(key, [...(files.get(key) ?? []), c]);
    }
    if (files.size < 2) return [step];
    changed = true;
    const reviewed = stepState(step, snapshot, guide.base) === 'reviewed';
    return [...files].map(([key, changes]) => {
      const stem = `${step.id}-${hash(key).slice(0, 12)}`;
      let id = stem, suffix = 2;
      while (used.has(id)) id = `${stem}-${suffix++}`;
      used.add(id);
      const file = changes[0].file;
      const sameFileComparisons = [...files.values()].filter(cs => cs[0].file === file).length > 1;
      const child: Step = { ...step, id, title: `${step.title} · ${file}${sameFileComparisons ? ` [${changes[0].comparisonId}]` : ''}`, changes: changes.map(c => c.id) };
      if (step.comments) child.comments = step.comments.filter(c => child.changes.includes(c.changeId));
      if (step.selections) child.selections = Object.fromEntries(Object.entries(step.selections).filter(([id]) => child.changes.includes(id)));
      if (reviewed) child.review = { ...step.review!, fingerprint: stepFingerprint(child, snapshot) };
      else if (step.review) child.review = { status: 'pending' };
      return [child];
    }).flat();
  }) }));
  return changed ? { ...guide, groups } : guide;
}

/** Persist explicit section -> change -> file nesting; the core operates on file leaves. */
export function serializeGuide(guide: Guide): string {
  if (allSteps(guide).some(step => !step.changeGroup || !step.file)) return JSON.stringify(guide, null, 2) + '\n';
  const groups = guide.groups.map(section => {
    const changes: { id: string; title: string; files: Omit<Step, 'changeGroup'>[] }[] = [];
    for (const step of section.steps) {
      let change = changes.find(c => c.id === step.changeGroup!.id);
      if (!change) { change = { ...step.changeGroup!, files: [] }; changes.push(change); }
      const { changeGroup, ...file } = step;
      change.files.push(file);
    }
    const { steps, ...rest } = section;
    return { ...rest, changes };
  });
  return JSON.stringify({ ...guide, version: 2, groups }, null, 2) + '\n';
}

/** Migrate existing plans without losing valid per-file review approvals. */
export function nestGuide(guide: Guide, snapshot: Snapshot): Guide {
  if (allSteps(guide).every(step => step.changeGroup && step.file)) return guide;
  const split = splitFileSteps(guide, snapshot);
  const current = new Map(snapshot.changes.map(c => [c.id, c]));
  // Missing changes cannot be assigned a trustworthy filename.
  if (allSteps(split).some(s => s.changes.some(id => !current.has(id)))) return split;
  const used = new Set([...split.groups.map(g => g.id), ...allSteps(split).map(s => s.id)]);
  return { ...split, groups: split.groups.map(section => {
    const titles = new Map<string, { id: string; title: string }>();
    const steps = section.steps.map(step => {
      const file = current.get(step.changes[0])!.file;
      const suffix = ` · ${file}`;
      const offset = step.title.lastIndexOf(suffix);
      const tail = offset >= 0 ? step.title.slice(offset + suffix.length) : undefined;
      const title = (tail === '' || /^ \[.*\]$/.test(tail ?? '') ? step.title.slice(0, offset) : step.title).replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, '');
      let changeGroup = titles.get(title);
      if (!changeGroup) {
        let id = `${section.id}-change-${hash(title).slice(0, 12)}`;
        while (used.has(id)) id += '-group';
        used.add(id); changeGroup = { id, title }; titles.set(title, changeGroup);
      }
      const child: Step = { ...step, file, changeGroup };
      if (stepState(step, snapshot, guide.base) === 'reviewed') child.review = { ...step.review!, fingerprint: stepFingerprint(child, snapshot) };
      return child;
    });
    return { ...section, steps };
  }) };
}
