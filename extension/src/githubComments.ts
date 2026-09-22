import { Gh, PullRequest, prComparison, remoteReview } from './githubSync';
import { Guide } from '../../packages/core/src/model';
export interface ReviewComment { databaseId: number; body: string; url: string; author: { login: string } | null; viewerDidAuthor: boolean }
export interface ReviewThread { id: string; path: string; line: number | null; startLine: number | null; diffSide: 'LEFT' | 'RIGHT'; startDiffSide: 'LEFT' | 'RIGHT' | null; isOutdated: boolean; isResolved: boolean; comments: ReviewComment[] }
export interface Discussion { head: string; threads: ReviewThread[] }
const fields = 'databaseId: fullDatabaseId body url author { login } viewerDidAuthor';
function data(response: any) {
  if (response.errors?.length || !response.data) throw new Error('GitHub could not return review discussions. Check repository access and try Refresh comments.');
  return response.data;
}
export async function readDiscussion(gh: Gh, pr: PullRequest): Promise<Discussion> {
  const [owner, name] = pr.repo.split('/');
  const threads: ReviewThread[] = [];
  let cursor: string | undefined, head = '';
  do {
    const args = ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr.number}`, '-f', `query=query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$cursor){nodes{id path line startLine diffSide startDiffSide isOutdated isResolved comments(first:100){nodes{${fields}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const result = data(await gh(args)).repository?.pullRequest;
    if (!result) throw new Error('GitHub PR not found or inaccessible.');
    if (head && head !== result.headRefOid) throw new Error('The PR changed while loading comments. Refresh comments.');
    head = result.headRefOid;
    for (const node of result.reviewThreads.nodes) {
      const comments = [...node.comments.nodes];
      let page = node.comments.pageInfo;
      const seen = new Set<string>();
      while (page.hasNextPage) {
        if (!page.endCursor || seen.has(page.endCursor)) throw new Error('GitHub comment pagination was incomplete.');
        seen.add(page.endCursor);
        const extra = data(await gh(['api', 'graphql', '-f', `id=${node.id}`, '-f', `cursor=${page.endCursor}`, '-f', `query=query($id:ID!,$cursor:String!){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{${fields}} pageInfo{hasNextPage endCursor}}}}}`])).node?.comments;
        if (!extra) throw new Error('GitHub thread changed while loading comments.');
        comments.push(...extra.nodes); page = extra.pageInfo;
      }
      const normalized = comments.map(comment => {
        const databaseId = Number(comment.databaseId);
        if (!Number.isSafeInteger(databaseId) || databaseId < 1) throw new Error('GitHub returned an unsupported comment identifier.');
        return { ...comment, databaseId };
      });
      threads.push({ ...node, comments: normalized });
    }
    const page = result.reviewThreads.pageInfo;
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) throw new Error('GitHub thread pagination was incomplete.');
    cursor = page.hasNextPage ? page.endCursor : undefined;
  } while (cursor);
  return { head, threads };
}
function bodyFields(body: string): string[] {
  if (!body.trim()) throw new Error('Enter a comment before posting.');
  return ['-f', `body=${body}`]; // Raw field: @ prefixes and Markdown remain literal.
}
export type CommentTarget = { path: string; side: 'LEFT' | 'RIGHT'; line: number; startLine?: number };
export async function postInline(gh: Gh, pr: PullRequest, guide: Guide, target: CommentTarget, body: string, current: () => Promise<boolean>): Promise<any> {
  const fields = bodyFields(body);
  if (!Number.isSafeInteger(target.line) || target.line < 1 || (target.startLine !== undefined && (!Number.isSafeInteger(target.startLine) || target.startLine < 1 || target.startLine > target.line))) throw new Error('Invalid comment range.');
  const remote = await remoteReview(gh, pr, guide);
  const file = remote.files.find(f => f.path === target.path || (target.side === 'LEFT' && f.previousPath === target.path));
  if (!file) throw new Error('This file is not part of the current PR.');
  if (!await current()) throw new Error('The active review changed. Reopen its diff before posting.');
  const latest = await gh(['api', `repos/${pr.repo}/pulls/${pr.number}`]);
  if (latest.state !== 'open' || latest.head.sha !== remote.head || latest.base.sha !== remote.base) throw new Error('The PR changed. Refresh the guide before posting.');
  if (!await current()) throw new Error('The active review changed.');
  const args = ['api', `repos/${pr.repo}/pulls/${pr.number}/comments`, '-X', 'POST', ...fields, '-f', `commit_id=${prComparison(guide).head}`, '-f', `path=${file.path}`, '-f', `side=${target.side}`, '-F', `line=${target.line}`];
  if (target.startLine && target.startLine !== target.line) args.push('-F', `start_line=${target.startLine}`, '-f', `start_side=${target.side}`);
  return gh(args);
}
async function checkComment(gh: Gh, pr: PullRequest, id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid GitHub comment.');
  const comment = await gh(['api', `repos/${pr.repo}/pulls/comments/${id}`]);
  if (comment.pull_request_url !== `https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`) throw new Error('The comment belongs to another PR.');
  return comment;
}
export async function replyComment(gh: Gh, pr: PullRequest, id: number, body: string, current: () => Promise<boolean>) {
  const fields = bodyFields(body);
  const comment = await checkComment(gh, pr, id);
  if (!await current()) throw new Error('The active review changed.');
  return gh(['api', `repos/${pr.repo}/pulls/${pr.number}/comments/${comment.in_reply_to_id ?? id}/replies`, '-X', 'POST', ...fields]);
}
export async function editComment(gh: Gh, pr: PullRequest, id: number, previous: string, body: string, current: () => Promise<boolean>) {
  const fields = bodyFields(body);
  const comment = await checkComment(gh, pr, id);
  const viewer = await gh(['api', 'user']);
  if (comment.user?.login !== viewer.login) throw new Error('You can edit only your own comments.');
  if (comment.body !== previous) throw new Error('This comment changed on GitHub. Refresh comments before editing it.');
  if (!await current()) throw new Error('The active review changed.');
  return gh(['api', `repos/${pr.repo}/pulls/comments/${id}`, '-X', 'PATCH', ...fields]);
}
