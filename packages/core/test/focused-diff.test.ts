import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Change } from '../src/model';
import { focusedDiff } from '../../../extension/src/focusedDiff';
const change = (id: string, oldStart: number, oldLines: number, newStart: number, newLines: number): Change => ({ id, file: 'file.ts', kind: 'text', oldStart, oldLines, newStart, newLines, patch: '' });
test('focus shows context but excludes nearby unselected hunks on both sides', () => {
  const first = change('first', 2, 1, 2, 1), other = change('other', 4, 1, 4, 1);
  const result = focusedDiff('a\nold1\nc\nold2\ne\n', 'a\nnew1\nc\nnew2\ne\n', [first], [first, other]);
  assert.match(result.before, /a\nold1\nc\n/); assert.match(result.after, /a\nnew1\nc\n/);
  assert.ok(!result.before.includes('old2')); assert.ok(!result.after.includes('new2'));
  assert.equal(result.changes[0].newStart, 3);
  assert.match(result.after, /Modified L1–3/);
});
test('a selection inside an added file excludes other slices even as context', () => {
  const all = change('added', 0, 0, 1, 6), selected = { ...all, newStart: 3, newLines: 2 };
  const result = focusedDiff('', 'one\ntwo\nthree\nfour\nfive\nsix\n', [selected], [all]);
  assert.match(result.after, /three\nfour\n$/);
  for (const line of ['one\n', 'two\n', 'five\n', 'six\n']) assert.ok(!result.after.includes(line));
  assert.equal(result.changes[0].newStart, 2); assert.equal(result.changes[0].newLines, 2);
});
test('replacement slices preserve independent original and modified coordinates', () => {
  const all = change('replace', 2, 3, 2, 4);
  const selected = { ...all, oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 };
  const result = focusedDiff('a\nold1\nold2\nold3\nz\n', 'a\nnew1\nnew2\nnew3\nnew4\nz\n', [selected], [all]);
  assert.match(result.before, /\nold2\n$/); assert.match(result.after, /\nnew2\nnew3\n$/);
  assert.ok(!result.before.includes('old1')); assert.ok(!result.after.includes('new4'));
  assert.equal(result.changes[0].oldStart, 2); assert.equal(result.changes[0].newStart, 2);
});
test('insertion and deletion context aligns without leaking another change', () => {
  const deletion = change('delete', 2, 1, 1, 0), insertion = change('insert', 3, 0, 3, 1);
  const result = focusedDiff('a\ndeleted\nb\nc\n', 'a\nb\nadded\nc\n', [deletion], [deletion, insertion]);
  assert.match(result.before, /a\ndeleted\nb\n/); assert.match(result.after, /a\nb\n/);
  assert.ok(!result.after.includes('added')); assert.equal(result.changes[0].oldStart, 3);
});
test('disjoint selections omit the middle and keep mapped ranges within excerpts', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
  const after = [...before]; after[1] = 'first'; after[27] = 'last';
  const changes = [change('first', 2, 1, 2, 1), change('last', 28, 1, 28, 1)];
  const result = focusedDiff(before.join('\n') + '\n', after.join('\n') + '\n', changes, changes);
  assert.ok(!result.before.includes('line15\n')); assert.equal(result.changes.length, 2);
  for (const [i, c] of result.changes.entries()) assert.equal(result.after.split('\n')[c.newStart - 1], i ? 'last' : 'first');
});
test('end-of-file markers, metadata and original-only slices remain visible', () => {
  const c = change('eof', 1, 1, 1, 1);
  const result = focusedDiff('old\n', 'new', [c], [c]);
  assert.match(result.after, /\\ No newline at end of file/); assert.ok(!result.before.includes('No newline'));
  const slice = focusedDiff('old\n', 'new\n', [{ ...c, newLines: 0 }], [c]);
  assert.ok(!slice.after.includes('new\n')); assert.match(slice.before, /old\n/);
  const mode = { ...c, kind: 'metadata' as const, oldLines: 0, newLines: 0, patch: 'old mode 100644\nnew mode 100755' };
  const metadata = focusedDiff('unrelated source\n', 'unrelated source\n', [mode], [mode]);
  assert.match(metadata.after, /new mode 100755/); assert.ok(!metadata.after.includes('unrelated source'));
});
