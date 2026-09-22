import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guide, Snapshot, Step, explanationAnchors, parseGuide, nestGuide, serializeGuide, stepFingerprint, stepState, validateCoverage } from '../src/model';
function fixture() {
  const id = `c_${'a'.repeat(64)}`;
  const snapshot: Snapshot = { version: 1, root: '/repo', base: 'a'.repeat(40), comparison: 'head-to-working-tree', changes: [{ id, file: 'file.ts', kind: 'text', oldStart: 10, oldLines: 3, newStart: 20, newLines: 30, patch: '' }] };
  const step: Step = { id: 'entry', title: 'File', file: 'file.ts', note: 'Introduction', changes: [id], comments: [{ changeId: id, side: 'modified', start: 2, end: 3, note: 'Policy' }, { changeId: id, side: 'original', start: 1, end: 1, note: 'Old behavior' }] };
  const guide: Guide = { version: 1, title: 'Guide', comparison: snapshot.comparison, base: snapshot.base, groups: [{ id: 'section', title: 'Section', steps: [step] }] };
  return { id, snapshot, step, guide };
}
test('multiple explanations round trip in v2 and anchor both diff sides without changing coverage', () => {
  const { step, snapshot, guide } = fixture();
  assert.deepEqual(explanationAnchors(step, snapshot).map(c => [c.side, c.line, c.endLine]), [['modified', 21, 22], ['original', 10, 10]]);
  const parsed = parseGuide(serializeGuide(nestGuide(guide, snapshot)));
  assert.deepEqual(parsed.groups[0].steps[0].comments, step.comments);
  assert.deepEqual(validateCoverage(parsed, snapshot).invalidComments, []);
  assert.deepEqual(validateCoverage(parsed, snapshot).missing, []);
  step.review = { status: 'reviewed', fingerprint: stepFingerprint(step, snapshot) };
  assert.equal(stepState(step, snapshot, guide.base), 'reviewed');
  step.comments![0].note = 'Changed explanation';
  assert.equal(stepState(step, snapshot, guide.base), 'stale');
});
test('invalid comment structure and anchors are rejected instead of moved to unrelated lines', () => {
  for (const comment of [null, { side: 'wrong' }, { start: 0 }, { end: 99 }, { note: '' }, { changeId: `c_${'b'.repeat(64)}` }]) {
    const { step, guide, snapshot } = fixture();
    step.comments = [comment === null ? null as any : { ...step.comments![0], ...comment } as any];
    if (comment?.end === 99) {
      assert.deepEqual(validateCoverage(guide, snapshot).invalidComments, ['entry']);
      assert.equal(stepState(step, snapshot, guide.base), 'stale');
    } else assert.throws(() => parseGuide(JSON.stringify(guide)), /comment/);
  }
  const { step, snapshot, id } = fixture();
  step.selections = { [id]: { modified: { start: 5, end: 10 } } };
  assert.throws(() => explanationAnchors(step, snapshot), /outside/);
  delete step.selections;
  snapshot.changes[0].kind = 'metadata';
  assert.throws(() => explanationAnchors(step, snapshot), /outside/);
});
test('adding an empty comments array preserves existing review fingerprints', () => {
  const { step, snapshot } = fixture();
  delete step.comments;
  const previous = stepFingerprint(step, snapshot);
  step.comments = [];
  assert.equal(stepFingerprint(step, snapshot), previous);
});
