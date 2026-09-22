import * as vscode from 'vscode';
import { Guide, Change } from '../../packages/core/src/model';
import { Gh, PullRequest, prComparison } from './githubSync';
import { Discussion, ReviewComment, ReviewThread, readDiscussion, postInline, replyComment, editComment } from './githubComments';
interface Session { gh: Gh; pr: PullRequest; guide: Guide; current: () => Promise<boolean> }
interface DocumentContext { uri: vscode.Uri; path: string; side: 'LEFT' | 'RIGHT'; ranges: vscode.Range[]; lines: number; comparison: string }
interface UiComment extends vscode.Comment { remote: ReviewComment; parent: vscode.CommentThread; savedBody: string }
export class GitHubCommentUi implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private controller!: vscode.CommentController;
  private session?: Session;
  private discussion?: Discussion;
  private documents = new Map<string, DocumentContext>();
  private threads = new Map<vscode.CommentThread, ReviewThread>();
  private busy = new Set<object>();
  private generation = 0;
  private comparison(guide: Guide): string { return JSON.stringify([guide.base, guide.scope, guide.pullRequestUrl]); }
  constructor() { this.createController(); }
  private createController(): void {
    this.controller = vscode.comments.createCommentController('agr-github', 'GitHub PR comments');
    this.controller.options = { prompt: 'Post a comment to GitHub', placeHolder: 'Post publishes immediately to GitHub. No pending review is created.' };
    this.controller.commentingRangeProvider = { provideCommentingRanges: document => {
      if (!this.session || this.discussion?.head !== prComparison(this.session.guide).head) return [];
      const doc = this.documents.get(document.uri.toString());
      return doc?.comparison === this.comparison(this.session.guide) ? doc.ranges : [];
    } };
  }
  reset(): void {
    this.generation++;
    this.session = undefined; this.discussion = undefined;
    this.documents.clear();
    this.threads.clear();
    this.controller.dispose();
    this.createController();
    this.changed.fire();
  }
  dispose(): void { this.reset(); this.controller.dispose(); this.changed.dispose(); }
  attach(path: string, left: vscode.Uri, right: vscode.Uri, before: string, after: string, changes: Change[], guide?: Guide): void {
    for (const [side, uri, content] of [['LEFT', left, before], ['RIGHT', right, after]] as const) {
      const lines = content.split('\n').length;
      const ranges = changes.filter(c => c.kind === 'text' && (side === 'LEFT' ? c.oldLines : c.newLines) > 0).map(c => {
        const start = (side === 'LEFT' ? c.oldStart : c.newStart) - 1;
        return new vscode.Range(start, 0, start + (side === 'LEFT' ? c.oldLines : c.newLines) - 1, 0);
      });
      this.documents.set(uri.toString(), { uri, path, side, ranges, lines, comparison: guide ? this.comparison(guide) : '' });
    }
    this.render();
  }
  async load(session: Session): Promise<void> {
    if (this.busy.size) throw new Error('Wait for the GitHub comment update to finish before reloading.');
    prComparison(session.guide);
    if ([...this.threads.keys()].some(t => t.comments.some(c => c.mode === vscode.CommentMode.Editing))) throw new Error('Save or cancel your comment edit before reloading.');
    const generation = ++this.generation;
    const discussion = await readDiscussion(session.gh, session.pr);
    if (generation !== this.generation || !await session.current()) return;
    if (this.session && (JSON.stringify(this.session.pr) !== JSON.stringify(session.pr) || this.comparison(this.session.guide) !== this.comparison(session.guide))) this.reset();
    this.session = session; this.discussion = discussion; this.render(); this.changed.fire();
    if (discussion.head !== prComparison(session.guide).head) void vscode.window.showWarningMessage('GitHub comments loaded, but the guide is outdated. Use Browse GitHub Discussions to read them. Refresh the guide before posting inline comments.');
  }
  fileStatus(paths: string[], guide?: Guide): { total: number; unresolved: number; outdated: number } {
    if (!guide || !this.session || !this.discussion || this.comparison(guide) !== this.comparison(this.session.guide)) return { total: 0, unresolved: 0, outdated: 0 };
    const threads = this.discussion.threads.filter(t => paths.includes(t.path) && t.comments.length > 0);
    return { total: threads.length, unresolved: threads.filter(t => !t.isResolved).length, outdated: threads.filter(t => t.isOutdated || this.discussion!.head !== prComparison(guide).head).length };
  }
  status(): { count: number; outdated: boolean } | undefined {
    return this.discussion && this.session ? { count: this.discussion.threads.length, outdated: this.discussion.head !== prComparison(this.session.guide).head } : undefined;
  }
  async refresh(): Promise<void> {
    if (!this.session) throw new Error('GitHub comments are not ready. Use Refresh GitHub Comments to retry.');
    if ([...this.threads.keys()].some(t => t.comments.some(c => c.mode === vscode.CommentMode.Editing))) throw new Error('Save or cancel your comment edit before refreshing.');
    await this.load(this.session);
  }
  private render(): void {
    if (!this.session || !this.discussion) return;
    const currentHead = this.discussion.head === prComparison(this.session.guide).head;
    for (const [thread, remote] of this.threads) {
      const replacement = this.discussion.threads.find(t => t.id === remote.id || t.comments[0]?.databaseId === remote.comments[0]?.databaseId);
      if (!replacement || replacement.isOutdated || !currentHead) {
        if (!thread.comments.some(c => c.mode === vscode.CommentMode.Editing)) { thread.dispose(); this.threads.delete(thread); }
      } else if (replacement.line !== remote.line || replacement.startLine !== remote.startLine || replacement.diffSide !== remote.diffSide || replacement.path !== remote.path) { thread.dispose(); this.threads.delete(thread); }
      else if (!thread.comments.some(c => c.mode === vscode.CommentMode.Editing)) this.populate(thread, replacement);
    }
    if (!currentHead) return;
    for (const remote of this.discussion.threads) {
      if (remote.isOutdated || !remote.line || [...this.threads.values()].some(t => t.id === remote.id)) continue;
      const doc = [...this.documents.values()].find(d => d.path === remote.path && d.side === remote.diffSide && d.comparison === this.comparison(this.session!.guide));
      if (!doc || remote.line > doc.lines) continue;
      const start = remote.startDiffSide && remote.startDiffSide !== remote.diffSide ? remote.line : remote.startLine ?? remote.line;
      if (start < 1 || start > remote.line) continue;
      const thread = this.controller.createCommentThread(doc.uri, new vscode.Range(start - 1, 0, remote.line - 1, 0), []);
      this.populate(thread, remote);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
  }
  private populate(thread: vscode.CommentThread, remote: ReviewThread) {
    this.threads.set(thread, remote);
    thread.label = `GitHub${remote.isResolved ? ' · Resolved' : ''}${remote.isOutdated ? ' · Outdated' : ''}`;
    thread.contextValue = 'agrGithub'; thread.canReply = true;
    thread.state = remote.isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    thread.comments = remote.comments.map(comment => this.comment(comment, thread));
  }
  private comment(remote: ReviewComment, parent: vscode.CommentThread): UiComment {
    const body = new vscode.MarkdownString(remote.body);
    body.isTrusted = false; body.supportHtml = false;
    return { remote, parent, savedBody: remote.body, body, mode: vscode.CommentMode.Preview, author: { name: remote.author?.login ?? 'Deleted user' }, contextValue: remote.viewerDidAuthor ? 'agrGithubOwn' : 'agrGithubOther' };
  }
  private async active(): Promise<Session> {
    if (!this.session || !vscode.workspace.isTrusted || !await this.session.current()) throw new Error('The active review changed. Use Refresh GitHub Comments to retry.');
    return this.session;
  }
  async add(): Promise<void> {
    const session = await this.active();
    const editor = vscode.window.activeTextEditor;
    const doc = editor && this.documents.get(editor.document.uri.toString());
    if (!editor || !doc || doc.comparison !== this.comparison(session.guide)) throw new Error('Select changed lines in an AGR diff first.');
    const start = editor.selection.start.line;
    const end = editor.selection.end.line - (editor.selection.end.character === 0 && editor.selection.end.line > start ? 1 : 0);
    if (!doc.ranges.some(r => r.start.line <= start && r.end.line >= end)) throw new Error('Select changed lines on one side of the PR diff.');
    const thread = this.controller.createCommentThread(doc.uri, new vscode.Range(start, 0, end, 0), []);
    thread.label = 'New GitHub comment';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }
  async post(reply: vscode.CommentReply): Promise<void> {
    if (this.busy.has(reply.thread)) return;
    this.busy.add(reply.thread);
    try {
      const session = await this.active();
      const doc = this.documents.get(reply.thread.uri.toString());
      if (!doc || doc.comparison !== this.comparison(session.guide)) throw new Error('Open a diff in this review before commenting.');
      const remote = this.threads.get(reply.thread);
      let result;
      if (remote) result = await replyComment(session.gh, session.pr, remote.comments[0].databaseId, reply.text, session.current);
      else {
        const range = reply.thread.range;
        if (!doc.ranges.some(r => r.start.line <= range.start.line && r.end.line >= range.end.line)) throw new Error('Select changed lines on one side of the PR diff.');
        result = await postInline(session.gh, session.pr, session.guide, { path: doc.path, side: doc.side, startLine: range.start.line + 1, line: range.end.line + 1 }, reply.text, session.current);
      }
      if (this.session !== session || !await session.current()) return;
      const comment: ReviewComment = { databaseId: result.id, body: result.body, url: result.html_url, author: { login: result.user.login }, viewerDidAuthor: true };
      const updated: ReviewThread = remote ? { ...remote, comments: [...remote.comments, comment] } : { id: `posted-${result.id}`, path: doc.path, line: reply.thread.range.end.line + 1, startLine: reply.thread.range.start.line + 1, diffSide: doc.side, startDiffSide: doc.side, isResolved: false, isOutdated: false, comments: [comment] };
      if (this.discussion) {
        const index = this.discussion.threads.findIndex(t => t.id === updated.id);
        if (index >= 0) this.discussion.threads[index] = updated; else this.discussion.threads.push(updated);
      }
      this.populate(reply.thread, updated);
      this.changed.fire();
      // Reconcile on explicit refresh; never automatically retry a write.
    } catch (error) {
      throw new Error(`${(error as Error).message} Your text remains in the editor. If the connection failed, check GitHub before posting again to avoid duplicates.`);
    } finally { this.busy.delete(reply.thread); }
  }
  edit(comment: UiComment): void {
    if (!this.threads.has(comment.parent) || !comment.remote.viewerDidAuthor) throw new Error('Select one of your GitHub comments.');
    comment.body = comment.savedBody; comment.mode = vscode.CommentMode.Editing;
    comment.parent.comments = [...comment.parent.comments];
  }
  cancel(comment: UiComment): void {
    comment.body = new vscode.MarkdownString(comment.savedBody); comment.mode = vscode.CommentMode.Preview;
    comment.parent.comments = [...comment.parent.comments];
  }
  async save(comment: UiComment): Promise<void> {
    if (this.busy.has(comment)) return;
    this.busy.add(comment);
    try {
      const session = await this.active();
      if (!this.threads.has(comment.parent) || !comment.remote.viewerDidAuthor) throw new Error('Select one of your GitHub comments.');
      const body = typeof comment.body === 'string' ? comment.body : comment.body.value;
      const result = await editComment(session.gh, session.pr, comment.remote.databaseId, comment.savedBody, body, session.current);
      comment.savedBody = result.body; comment.remote.body = result.body;
      this.cancel(comment);
    } finally { this.busy.delete(comment); }
  }
  async browse(): Promise<void> {
    if (!this.discussion) throw new Error('GitHub comments are not ready. Use Refresh GitHub Comments to retry.');
    const choices = this.discussion.threads.filter(t => t.comments.length).map(t => ({ label: `${t.path}${t.line ? `:${t.line}` : ''}`, description: `${t.isOutdated ? 'Outdated · ' : ''}${t.isResolved ? 'Resolved · ' : ''}${t.comments.length} comments`, detail: t.comments[0].body, thread: t }));
    if (!choices.length) { void vscode.window.showInformationMessage('No GitHub review discussions yet.'); return; }
    const selected = await vscode.window.showQuickPick(choices, { title: 'GitHub discussions', placeHolder: 'Open a thread on GitHub, including outdated threads' });
    if (selected) {
      const url = selected.thread.comments[0].url;
      if (url.startsWith(`https://github.com/${this.session!.pr.repo}/pull/${this.session!.pr.number}#`)) await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }
}
