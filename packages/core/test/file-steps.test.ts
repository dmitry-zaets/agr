import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guide, Snapshot, Step, allSteps, splitFileSteps, stepFingerprint, stepState, validateCoverage } from '../src/model';
function fixture() {
  const snapshot: Snapshot = { version: 1, root: '/repo', base: 'base', comparison: 'head-to-working-tree', changes: ['a.ts', 'b.ts'].map((file, n) => ({ id: `c_${n}`, file, kind: 'text', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, patch: '' })) };
  const step: Step = { id: 'shared', title: 'Shared concern', note: 'Shared note', focus: 'Check this', optional: true, changes: snapshot.changes.map(c => c.id), selections: Object.fromEntries(snapshot.changes.map(c => [c.id, { original: { start: 1, end: 2 }, modified: { start: 1, end: 2 } }])) };
  const guide: Guide = { version: 1, title: 'Guide', comparison: 'head-to-working-tree', base: 'base', groups: [{ id: 'group', title: 'Concern', steps: [step] }] };
  return { guide, snapshot, step };
}
test('split entries keep notes, ranges, order and valid review approval without mutating input', () => {
  const { guide, snapshot, step } = fixture();
  step.review = { status: 'reviewed', fingerprint: stepFingerprint(step, snapshot), reviewedAt: '2026-09-21T00:00:00Z' };
  const original = JSON.stringify(guide);
  assert.deepEqual(validateCoverage(guide, snapshot).multiFileSteps, ['shared']);
  const result = splitFileSteps(guide, snapshot), steps = allSteps(result);
  assert.equal(steps.length, 2);
  assert.equal(JSON.stringify(guide), original);
  assert.deepEqual(steps.map(s => s.changes), [['c_0'], ['c_1']]);
  for (const s of steps) {
    assert.equal(s.note, step.note); assert.equal(s.focus, step.focus); assert.equal(s.optional, true);
    assert.deepEqual(Object.keys(s.selections!), s.changes);
    assert.equal(s.review?.reviewedAt, step.review.reviewedAt);
    assert.equal(stepState(s, snapshot, result.base), 'reviewed');
  }
  assert.deepEqual(validateCoverage(result, snapshot).multiFileSteps, []);
  assert.equal(splitFileSteps(result, snapshot), result, 'migration is idempotent');
});
test('stale approvals are not transferred and missing IDs are never dropped', () => {
  const { guide, snapshot, step } = fixture();
  step.review = { status: 'reviewed', fingerprint: stepFingerprint(step, snapshot) };
  step.note = 'Changed explanation';
  assert.ok(allSteps(splitFileSteps(guide, snapshot)).every(s => s.review?.status === 'pending'));
  step.changes.push('missing');
  assert.equal(splitFileSteps(guide, snapshot), guide);
  assert.ok(step.changes.includes('missing'));
});
test('different comparisons of one file become distinct entries; ordinary single-file entries stay intact', () => {
  const { guide, snapshot } = fixture();
  snapshot.changes[1].file = 'a.ts';
  assert.equal(splitFileSteps(guide, snapshot), guide);
  snapshot.changes[0].comparisonId = 'staged'; snapshot.changes[1].comparisonId = 'unstaged';
  const result = splitFileSteps(guide, snapshot);
  assert.equal(allSteps(result).length, 2);
  assert.match(allSteps(result)[0].title, /staged/);
  assert.match(allSteps(result)[1].title, /unstaged/);
  assert.deepEqual(allSteps(splitFileSteps(guide, snapshot)).map(s => s.id), allSteps(result).map(s => s.id));
});
