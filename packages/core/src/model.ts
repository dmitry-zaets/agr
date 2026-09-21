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
export interface Step {
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
  const g = JSON.parse(text);
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
  return hash(JSON.stringify([snapshot.base, step.id, step.title, step.note, step.focus, step.optional, [...step.changes].sort(), Object.entries(step.selections ?? {}).sort(([a], [b]) => a.localeCompare(b))]));
}
export function selectedChanges(step: Step, snapshot: Snapshot): Change[] {
  return step.changes.flatMap(id => {
    const change = snapshot.changes.find(c => c.id === id);
    if (!change) return [];
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
export function stepState(step: Step, snapshot: Snapshot, guideBase: string | null): 'pending' | 'reviewed' | 'stale' {
  if (guideBase !== snapshot.base || selectedChanges(step, snapshot).length !== step.changes.length) return 'stale';
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

export function validateCoverage(guide: Guide, snapshot: Snapshot): { missing: string[]; unknown: string[]; invalidSelections: string[]; baseMatches: boolean } {
  const current = new Set(snapshot.changes.map(c => c.id));
  return {
    missing: uncoveredChanges(guide, snapshot).map(c => c.id),
    unknown: [...new Set(allSteps(guide).flatMap(s => s.changes).filter(id => !current.has(id)))],
    invalidSelections: allSteps(guide).filter(step => step.changes.every(id => current.has(id)) && selectedChanges(step, snapshot).length !== step.changes.length).map(step => step.id),
    baseMatches: guide.base === snapshot.base
  };
}
