import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guide, Snapshot, Step, stepFingerprint, parseGuide } from '../src/model';
import { fileReviewed, parsePullRequest, prComparison, remoteReview, syncFiles, Gh } from '../../../extension/src/githubSync';

function fixture() {
  const snapshot: Snapshot = { version: 1, root: '/repo', base: 'scope', comparison: 'scoped', changes: [{ id: 'change', file: 'file.ts', kind: 'text', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, patch: '' }] };
  const steps: Step[] = [1, 2].map(n => ({ id: `step${n}`, title: 'Part', note: '', changes: ['change'], selections: { change: { original: { start: n, end: n }, modified: { start: n, end: n } } } }));
  const guide: Guide = { version: 1, title: 'PR', comparison: 'scoped', base: 'scope', scope: { comparisons: [{ id: 'pr', kind: 'revisions', base: 'a'.repeat(40), head: 'b'.repeat(40) }] }, groups: [{ id: 'group', title: 'Group', steps }] };
  const approve = () => steps.forEach(s => { s.review = { status: 'reviewed', fingerprint: stepFingerprint(s, snapshot) }; });
  return { snapshot, guide, steps, approve };
}
const pr = { repo: 'owner/repo', number: 12 };
function mock(head = 'b'.repeat(40), base = 'a'.repeat(40)) {
  const calls: string[][] = [];
  const gh: Gh = async args => {
    calls.push(args);
    if (args.includes('graphql')) return {};
    if (args.includes('--paginate')) return [[{ filename: 'file.ts', status: 'modified' }]];
    if (args[1].includes('/compare/')) return { merge_base_commit: { sha: base } };
    return { state: 'open', node_id: 'PR_id', head: { sha: head }, base: { sha: 'c'.repeat(40) }, changed_files: 1 };
  };
  return { gh, calls, mutations: () => calls.filter(c => c.includes('graphql')) };
}
test('PR links and scope eligibility reject unsupported input', () => {
  assert.deepEqual(parsePullRequest('https://github.com/owner/repo/pull/12'), pr);
  for (const url of ['http://github.com/o/r/pull/1', 'https://evil.test/o/r/pull/1', 'https://github.com/o/r/pull/0']) assert.throws(() => parsePullRequest(url));
  const { guide } = fixture();
  assert.doesNotThrow(() => prComparison(guide));
  guide.scope!.comparisons[0].paths = ['file.ts'];
  assert.throws(() => prComparison(guide));
  delete guide.scope!.comparisons[0].paths;
  guide.scope!.comparisons.push({ id: 'local', kind: 'unstaged' });
  assert.throws(() => prComparison(guide));
});
test('whole file approval requires both sides, every range, and fresh optional steps', () => {
  const { guide, snapshot, steps, approve } = fixture();
  approve(); assert.equal(fileReviewed(guide, snapshot, ['file.ts']), true);
  steps[1].review = { status: 'pending' }; steps[1].optional = true;
  assert.equal(fileReviewed(guide, snapshot, ['file.ts']), false);
  approve(); steps[0].note = 'changed';
  assert.equal(fileReviewed(guide, snapshot, ['file.ts']), false);
  approve(); delete steps[1].selections!.change.original; approve();
  assert.equal(fileReviewed(guide, snapshot, ['file.ts']), false);
  assert.equal(fileReviewed(guide, snapshot, ['absent']), false);
});
test('sync marks reviewed files and unmarks affected files, but initial sync preserves other flags', async () => {
  const { guide, snapshot, steps, approve } = fixture(); const m = mock();
  await syncFiles(m.gh, pr, guide, snapshot, undefined, async () => true);
  assert.equal(m.mutations().length, 0);
  approve(); await syncFiles(m.gh, pr, guide, snapshot, ['file.ts'], async () => true);
  assert.match(m.mutations()[0].at(-1)!, /\{ markFileAsViewed/);
  steps[0].review = { status: 'pending' };
  await syncFiles(m.gh, pr, guide, snapshot, ['file.ts'], async () => true);
  assert.match(m.mutations()[1].at(-1)!, /\{ unmarkFileAsViewed/);
  await syncFiles(m.gh, pr, guide, snapshot, ['other.ts'], async () => true);
  assert.equal(m.mutations().length, 2);
});
test('head, merge base, incomplete API file lists, and cancellation prevent writes', async () => {
  const { guide, snapshot, approve } = fixture(); approve();
  for (const m of [mock('d'.repeat(40)), mock(undefined, 'd'.repeat(40))]) {
    await assert.rejects(syncFiles(m.gh, pr, guide, snapshot, undefined, async () => true));
    assert.equal(m.mutations().length, 0);
  }
  const m = mock();
  await syncFiles(m.gh, pr, guide, snapshot, undefined, async () => false);
  assert.equal(m.mutations().length, 0);
  await assert.rejects(remoteReview(async args => args.includes('--paginate') ? [[]] : m.gh(args), pr, guide), /complete PR file list/);
  let reads = 0;
  await assert.rejects(syncFiles(async args => {
    const result = await m.gh(args);
    if (args[1] === 'repos/owner/repo/pulls/12' && ++reads === 2) result.head.sha = 'd'.repeat(40);
    return result;
  }, pr, guide, snapshot, undefined, async () => true), /changed during sync/);
  assert.equal(m.mutations().length, 0);
});
test('renamed files require reviewed deletion and addition before marking the new path', async () => {
  const { guide, snapshot, approve } = fixture(); approve(); const m = mock();
  snapshot.changes.push({ ...snapshot.changes[0], id: 'old', file: 'old.ts', newLines: 0 });
  const gh: Gh = args => args.includes('--paginate') ? Promise.resolve([[{ filename: 'file.ts', previous_filename: 'old.ts', status: 'renamed' }]]) : m.gh(args);
  await syncFiles(gh, pr, guide, snapshot, undefined, async () => true);
  assert.equal(m.mutations().length, 0);
  guide.groups[0].steps.push({ id: 'old-step', title: 'Old', note: '', changes: ['old'] }); approve();
  await syncFiles(gh, pr, guide, snapshot, ['old.ts'], async () => true);
  assert.equal(m.mutations().length, 1); assert.ok(m.mutations()[0].includes('path=file.ts'));
});

test('PR metadata is optional and validated without enabling sync', () => {
  const guide = { version: 1, title: 'PR', comparison: 'head-to-working-tree', base: null, groups: [] };
  assert.equal(parseGuide(JSON.stringify(guide)).pullRequestUrl, undefined);
  const url = 'https://github.com/owner/repo/pull/123';
  assert.equal(parseGuide(JSON.stringify({ ...guide, pullRequestUrl: url })).pullRequestUrl, url);
  for (const value of [null, {}, 'https://evil.test/a/b/pull/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/999999999999999999999']) {
    assert.throws(() => parseGuide(JSON.stringify({ ...guide, pullRequestUrl: value })), /pullRequestUrl/);
  }
});
