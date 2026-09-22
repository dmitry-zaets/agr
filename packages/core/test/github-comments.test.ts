import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postInline, replyComment, editComment, readDiscussion } from '../../../extension/src/githubComments';
import { Guide } from '../src/model';
const pr = { repo: 'owner/repo', number: 5 };
const guide: Guide = { version: 1, title: 'PR', comparison: 'scoped', base: 'f'.repeat(64), scope: { comparisons: [{ id: 'pr', kind: 'revisions', base: 'a'.repeat(40), head: 'b'.repeat(40) }] }, groups: [] };
function fixture() {
  const writes: string[][] = [];
  let head = 'b'.repeat(40), author = 'me', body = 'Old text';
  const gh = async (args: string[]) => {
    if (args.includes('-X')) { writes.push(args); return { id: 7, body: args[args.indexOf('-f') + 1].slice(5) }; }
    if (args[1] === 'user') return { login: 'me' };
    if (args[1] === 'repos/owner/repo/pulls/comments/7') return { user: { login: author }, body, pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/5' };
    if (args[1] === 'repos/owner/repo/pulls/5') return { state: 'open', node_id: 'PR', head: { sha: head }, base: { sha: 'a'.repeat(40) }, changed_files: 1 };
    if (args[1]?.includes('/compare/')) return { merge_base_commit: { sha: 'a'.repeat(40) } };
    if (args.includes('--paginate')) return [[{ filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed' }]];
    throw new Error('Unexpected request');
  };
  return { gh, writes, setHead: (v: string) => head = v, setAuthor: (v: string) => author = v, setBody: (v: string) => body = v };
}
test('inline comments use commit, correct side, renamed path, and raw multiline body', async () => {
  const f = fixture();
  await postInline(f.gh, pr, guide, { path: 'old.ts', side: 'LEFT', line: 4, startLine: 2 }, '@literal\n**text**', async () => true);
  const args = f.writes[0];
  for (const field of ['path=new.ts', 'side=LEFT', 'line=4', 'start_line=2', 'start_side=LEFT', '@literal\n**text**']) assert.ok(args.some(a => a.includes(field)));
  assert.ok(args.includes('commit_id=' + 'b'.repeat(40)));
});
test('stale PRs, switched guides, invalid paths, and empty bodies cause no writes', async () => {
  const f = fixture(), target = { path: 'new.ts', side: 'RIGHT' as const, line: 1 };
  await assert.rejects(postInline(f.gh, pr, guide, target, '', async () => true), /Enter/);
  await assert.rejects(postInline(f.gh, pr, guide, target, 'text', async () => false), /changed/);
  await assert.rejects(postInline(f.gh, pr, guide, { ...target, path: 'elsewhere' }, 'text', async () => true), /not part/);
  f.setHead('c'.repeat(40));
  await assert.rejects(postInline(f.gh, pr, guide, target, 'text', async () => true), /outdated/);
  assert.equal(f.writes.length, 0);
});
test('editing checks author and intervening edits; replies use their own endpoint', async () => {
  const f = fixture();
  f.setAuthor('other');
  await assert.rejects(editComment(f.gh, pr, 7, 'Old text', 'New', async () => true), /own/);
  f.setAuthor('me'); f.setBody('Changed elsewhere');
  await assert.rejects(editComment(f.gh, pr, 7, 'Old text', 'New', async () => true), /changed on GitHub/);
  assert.equal(f.writes.length, 0);
  await editComment(f.gh, pr, 7, 'Changed elsewhere', 'New', async () => true);
  await replyComment(f.gh, pr, 7, 'Reply', async () => true);
  assert.ok(f.writes[0].includes('PATCH'));
  assert.equal(f.writes[1][1], 'repos/owner/repo/pulls/5/comments/7/replies');
});
test('threads and replies paginate independently and API errors fail visibly', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args.includes('id=T')) return { data: { node: { comments: { nodes: [{ databaseId: '2147483649' }], pageInfo: { hasNextPage: false } } } } };
    return { data: { repository: { pullRequest: { headRefOid: 'b'.repeat(40), reviewThreads: {
      nodes: args.includes('cursor=next') ? [] : [{ id: 'T', comments: { nodes: [{ databaseId: 1 }], pageInfo: { hasNextPage: true, endCursor: 'replies' } } }],
      pageInfo: args.includes('cursor=next') ? { hasNextPage: false } : { hasNextPage: true, endCursor: 'next' }
    } } } } };
  };
  const result = await readDiscussion(gh, pr);
  assert.equal(calls.length, 3);
  assert.equal(result.threads[0].comments.length, 2);
  assert.equal(result.threads[0].comments[1].databaseId, 2147483649);
  await assert.rejects(readDiscussion(async () => ({ errors: [{ message: 'no access' }] }), pr), /could not return/);
});
