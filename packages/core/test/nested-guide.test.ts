import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allSteps, Guide, Snapshot, nestGuide, parseGuide, serializeGuide, stepFingerprint, stepState, validateCoverage } from '../src/model';
function fixture() {
  const snapshot: Snapshot = { version: 1, root: '/repo', base: 'a'.repeat(40), comparison: 'head-to-working-tree', changes: ['one.ts', 'two.ts'].map((file, i) => ({ file, id: `c_${String(i).repeat(64)}`, kind: 'text', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: '' })) };
  const guide: Guide = { version: 1, title: 'Example', comparison: snapshot.comparison, base: snapshot.base, groups: [{ id: 'section', title: '1. Section', steps: [{ id: 'change', title: 'Change', note: 'Review both files', changes: snapshot.changes.map(c => c.id) }] }] };
  return { guide, snapshot };
}
test('nested wire format round trips approvals, filenames and explicit change groups', () => {
  const { guide, snapshot } = fixture();
  const step = allSteps(guide)[0];
  step.review = { status: 'reviewed', fingerprint: stepFingerprint(step, snapshot) };
  const nested = nestGuide(guide, snapshot);
  const wire = JSON.parse(serializeGuide(nested));
  assert.equal(wire.version, 2);
  assert.equal(wire.groups[0].steps, undefined);
  assert.deepEqual(wire.groups[0].changes[0].files.map((f: any) => f.file), ['one.ts', 'two.ts']);
  const parsed = parseGuide(JSON.stringify(wire));
  assert.deepEqual(parsed, nested);
  assert.equal(nestGuide(parsed, snapshot), parsed);
  assert.ok(allSteps(parsed).every(s => stepState(s, snapshot, parsed.base) === 'reviewed'));
  wire.groups[0].changes[0].title = 'Changed explanation';
  assert.ok(allSteps(parseGuide(JSON.stringify(wire))).every(s => stepState(s, snapshot, parsed.base) === 'stale'));
});
test('invalid nested structures and wrong file references are rejected', () => {
  const { guide, snapshot } = fixture();
  const wire = JSON.parse(serializeGuide(nestGuide(guide, snapshot)));
  const malformed = structuredClone(wire); malformed.groups[0].changes[0].files = [];
  assert.throws(() => parseGuide(JSON.stringify(malformed)), /files/);
  const duplicate = structuredClone(wire); duplicate.groups[0].changes[0].id = 'section';
  assert.throws(() => parseGuide(JSON.stringify(duplicate)), /duplicate/);
  const traversal = structuredClone(wire); traversal.groups[0].changes[0].files[0].file = '../one.ts';
  assert.throws(() => parseGuide(JSON.stringify(traversal)), /relative/);
  wire.groups[0].changes[0].files[0].file = 'wrong.ts';
  assert.equal(validateCoverage(parseGuide(JSON.stringify(wire)), snapshot).invalidSelections.length, 1);
});
test('migration never approves stale entries and keeps unresolved plans intact', () => {
  const { guide, snapshot } = fixture();
  const step = allSteps(guide)[0];
  step.review = { status: 'reviewed', fingerprint: 'outdated' };
  assert.ok(allSteps(nestGuide(guide, snapshot)).every(s => s.review?.status !== 'reviewed'));
  step.changes.push(`c_${'f'.repeat(64)}`);
  assert.equal(nestGuide(guide, snapshot), guide);
});
