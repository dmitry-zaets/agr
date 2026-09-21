import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allSteps, Guide, Snapshot, stepState, uncoveredChanges, validateCoverage } from '../../packages/core/src/model';

const exec = promisify(execFile);
export interface PullRequest { repo: string; number: number }
export interface RemoteReview { id: string; head: string; base: string; files: { path: string; previousPath?: string }[] }
export class OutdatedReviewError extends Error {
  constructor(public readonly pr: PullRequest, detail: string) {
    super(`AGR review is outdated. ${detail} GitHub Viewed sync is paused. Ask your agent to refresh the guide for the current PR, then reconnect it.`);
    this.name = 'OutdatedReviewError';
  }
}
export type Gh = (args: string[]) => Promise<any>;
export function github(root: string): Gh {
  return async args => {
    try {
      const { stdout } = await exec('gh', args[0] === 'api' ? [...args, '--hostname', 'github.com'] : args, { cwd: root, timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
      return JSON.parse(stdout);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(code === 'ENOENT' ? 'Install GitHub CLI (gh) and run gh auth login first.' : 'GitHub sync failed. Check gh auth status, repository access, and your connection, then retry.');
    }
  };
}
export function parsePullRequest(value: string): PullRequest {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(value.trim());
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('Enter a GitHub PR URL, such as https://github.com/owner/repo/pull/123.');
  return { repo: match[1], number: Number(match[2]) };
}
export function prComparison(guide: Guide) {
  const comparisons = guide.scope?.comparisons;
  const c = comparisons?.[0];
  if (guide.comparison !== 'scoped' || comparisons?.length !== 1 || c?.kind !== 'revisions' || c.paths || !/^[a-f0-9]{40,64}$/.test(c.head ?? '') || !/^[a-f0-9]{40,64}$/.test(c.base ?? '')) {
    throw new Error('GitHub sync needs one complete PR comparison with pinned commits and no path filters. Generate a separate PR guide first.');
  }
  return c;
}
export async function remoteReview(gh: Gh, pr: PullRequest, guide: Guide): Promise<RemoteReview> {
  const c = prComparison(guide);
  const info = await gh(['api', `repos/${pr.repo}/pulls/${pr.number}`]);
  if (info.state !== 'open') throw new OutdatedReviewError(pr, 'The PR is closed.');
  if (info.head.sha !== c.head) throw new OutdatedReviewError(pr, `Guide commit: ${c.head!.slice(0, 8)}. Current PR commit: ${info.head.sha.slice(0, 8)}.`);
  const comparison = await gh(['api', `repos/${pr.repo}/compare/${info.base.sha}...${info.head.sha}`]);
  if (comparison.merge_base_commit.sha !== c.base) throw new OutdatedReviewError(pr, `Guide merge base: ${c.base!.slice(0, 8)}. Current PR merge base: ${comparison.merge_base_commit.sha.slice(0, 8)}.`);
  const pages = await gh(['api', '--paginate', '--slurp', `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`]);
  const files = pages.flat();
  if (files.length !== info.changed_files) throw new Error('GitHub did not return the complete PR file list. Sync was stopped.');
  return { id: info.node_id, head: info.head.sha, base: info.base.sha, files: files.map((f: any) => ({ path: f.filename, previousPath: f.status === 'renamed' ? f.previous_filename : undefined })) };
}
export function fileReviewed(guide: Guide, snapshot: Snapshot, paths: string[]): boolean {
  if (guide.base !== snapshot.base) return false;
  const changes = snapshot.changes.filter(c => paths.includes(c.file));
  if (!changes.length) return false;
  const steps = allSteps(guide).filter(s => s.changes.some(id => changes.some(c => c.id === id)));
  if (!steps.length || steps.some(s => stepState(s, snapshot, guide.base) !== 'reviewed')) return false;
  return !uncoveredChanges(guide, snapshot).some(c => paths.includes(c.file));
}
export async function syncFiles(gh: Gh, pr: PullRequest, guide: Guide, snapshot: Snapshot, affected: string[] | undefined, isCurrent: () => Promise<boolean>): Promise<void> {
  const coverage = validateCoverage(guide, snapshot);
  if (!coverage.baseMatches || coverage.unknown.length || coverage.invalidSelections.length) throw new Error('The guide has stale changes or invalid ranges. Regenerate it before syncing.');
  const remote = await remoteReview(gh, pr, guide);
  for (const file of remote.files) {
    const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
    if (affected && !paths.some(p => affected.includes(p))) continue;
    const viewed = fileReviewed(guide, snapshot, paths);
    // Connecting a guide imports no state and never clears unrelated Viewed flags.
    if (!affected && !viewed) continue;
    if (!await isCurrent()) return;
    const latest = await gh(['api', `repos/${pr.repo}/pulls/${pr.number}`]);
    if (latest.state !== 'open' || latest.head.sha !== remote.head || latest.base.sha !== remote.base) throw new OutdatedReviewError(pr, `The PR changed during sync. Guide commit: ${remote.head.slice(0, 8)}. Current PR commit: ${latest.head.sha.slice(0, 8)}.`);
    if (!await isCurrent()) return;
    const mutation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
    await gh(['api', 'graphql', '-f', `pr=${remote.id}`, '-f', `path=${file.path}`, '-f', `query=mutation($pr: ID!, $path: String!) { ${mutation}(input: {pullRequestId: $pr, path: $path}) { clientMutationId } }`]);
  }
}
