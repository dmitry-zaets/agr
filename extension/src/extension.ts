import * as vscode from 'vscode';
import { overviewHtml, summaryExcerpt } from './overview';
import { GitHubCommentUi } from './githubCommentUi';
import { github, OutdatedReviewError, parsePullRequest, prComparison, PullRequest, remoteReview, syncFiles } from './githubSync';
import { appendReviewText } from './commentText';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { outdatedSkills, updateInstalledSkills } from './skillUpdate';
import { installSkills, skillTargets, InstallScope } from './skillInstall';
import { allSteps, Change, Guide, hash, parseGuide, selectedChanges, Snapshot, Step, stepFingerprint, nestGuide, serializeGuide, stepState, uncoveredChanges } from '../../packages/core/src/model';
import { git, repositoryRoot } from '../../packages/core/src/git';
import { listReviews, reviewPath, ReviewFile } from '../../packages/core/src/reviews';
import { changeContent, snapshotForGuide, scopeLabel } from '../../packages/core/src/scope';

class Item extends vscode.TreeItem {
  children: Item[] = [];
  constructor(label: string, public step?: Step, public change?: Change, public reviewFile?: string) { super(label); }
}

class Agr implements vscode.TreeDataProvider<Item>, vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly githubComments = new GitHubCommentUi();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly documents = new Map<string, string>();
  private readonly comments = vscode.comments.createCommentController('agr', 'AGR');
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerColor: new vscode.ThemeColor('focusBorder'), overviewRulerLane: vscode.OverviewRulerLane.Right
  });
  private threads: vscode.CommentThread[] = [];
  private highlights = new Map<string, vscode.Range[]>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly githubClient = github;
  private readonly outdatedNotices = new Set<string>();
  private readonly githubPrompts = new Set<string>();
  private githubPromptPending = false;
  private manualGitHubConnection = false;
  private readonly askGitHubSync = (url: string) => vscode.window.showInformationMessage(`Sync reviewed files to this GitHub PR? ${url}`, 'Enable sync', 'Keep local');
  private githubQueue: Promise<void> = Promise.resolve();
  private readonly githubStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private disposed = false;
  private skillUpdatePending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private mutation: Promise<void> = Promise.resolve();
  private pendingReviews = new Map<string, { token: symbol; reviewed: boolean }>();
  private items: Item[] = [];
  private root?: string;
  private guide?: Guide;
  private reviewFile?: string;
  private reviews: ReviewFile[] = [];
  private epoch = 0;
  private get reviewKey(): string | undefined { return this.root && this.reviewFile ? path.join(this.root, '.agr', this.reviewFile) : undefined; }
  private snapshot?: Snapshot;
  private activeId?: string;
  private activeItem?: Item;
  private openRequest = 0;
  private openTransition: Promise<void> = Promise.resolve();
  private renderedDiff?: string;
  private openedFingerprints = new Map<string, string>();
  readonly view: vscode.TreeView<Item>;

  constructor(private context: vscode.ExtensionContext) {
    this.view = vscode.window.createTreeView('agr.steps', { treeDataProvider: this, manageCheckboxStateManually: true, showCollapseAll: true });
    this.disposables.push(this.githubStatus, this.view, this.comments, this.decoration, this.changed,
      vscode.workspace.registerTextDocumentContentProvider('agr', this),
      this.view.onDidChangeVisibility(event => { if (event.visible) void this.offerGitHubSync(); }),
      this.view.onDidChangeCheckboxState(event => {
        for (const [item, state] of event.items) this.runToggle(item, state === vscode.TreeItemCheckboxState.Checked);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.root = undefined; this.resetReview(); this.schedule(); })
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const observe = (uri: vscode.Uri) => {
      const relative = this.root ? path.relative(this.root, uri.fsPath) : '';
      if (!relative.split(path.sep).some(p => ['node_modules', '.git', 'dist'].includes(p)) && !relative.startsWith('.agr' + path.sep + '.cache' + path.sep)) this.schedule();
    };
    this.disposables.push(watcher, watcher.onDidChange(observe), watcher.onDidCreate(observe), watcher.onDidDelete(observe));
  }
  dispose(): void { this.githubComments.dispose(); this.disposed = true; if (this.timer) clearTimeout(this.timer); this.threads.forEach(t => t.dispose()); this.disposables.forEach(d => d.dispose()); }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.documents.get(uri.toString()) ?? ''; }
  getTreeItem(item: Item): vscode.TreeItem {
    const pending = item.step && this.pendingReviews.get(item.step.id);
    if (!pending) return item;
    return Object.assign(new vscode.TreeItem(item.label ?? ''), item, {
      iconPath: new vscode.ThemeIcon('loading~spin'),
      description: 'Saving review…',
      checkboxState: pending.reviewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked
    });
  }
  getChildren(item?: Item): Item[] { return item ? (this.treeItems().find(current => current.id && current.id === item.id) ?? item).children : this.items; }
  private treeItems(items = this.items): Item[] { return items.flatMap(item => [item, ...this.treeItems(item.children)]); }
  getParent(item: Item): Item | undefined { return this.treeItems().find(parent => parent.children.some(child => child === item || (item.id && child.id === item.id))); }
  private schedule(): void { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => void this.refresh(), 650); }

  async selectRepository(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = [...new Set(await Promise.all(folders.map(async folder => {
      try { return await repositoryRoot(folder.uri.fsPath); } catch { return ''; }
    })))].filter(Boolean);
    if (!roots.length) throw new Error('Open a local Git repository in VS Code first.');
    const picked = roots.length === 1 ? roots[0] : await vscode.window.showQuickPick(roots, { title: 'Choose repository to review' });
    if (picked) {
      this.root = picked;
      this.resetReview();
      await this.context.workspaceState.update('agr.root', picked);
      // Watch the actual Git directory too (including worktree HEAD and index).
      const gitDir = (await git(picked, ['rev-parse', '--absolute-git-dir'])).trim();
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitDir, '{HEAD,index,refs/**,packed-refs}'));
      this.disposables.push(watcher, watcher.onDidChange(() => this.schedule()), watcher.onDidCreate(() => this.schedule()));
    }
    await this.refresh();
  }

  private resetReview(file?: string): void {
    this.githubComments.reset();
    this.githubStatus.hide();
    this.renderedDiff = undefined;
    this.epoch++; this.generation++;
    this.reviewFile = file; this.guide = undefined; this.snapshot = undefined;
    this.activeId = undefined; this.activeItem = undefined; this.items = [];
    this.openedFingerprints.clear(); this.pendingReviews.clear();
    this.threads.forEach(thread => thread.dispose()); this.threads = [];
    this.highlights.clear(); this.decorate();
  }
  async selectReview(file?: string): Promise<void> {
    await this.refresh();
    if (!this.root) throw new Error('Open a Git repository first.');
    const root = this.root;
    const reviews = await listReviews(root);
    if (!reviews.length) throw new Error('No reviews found. Ask your agent to create .agr/<name>.json.');
    if (!file) {
      const choices = await Promise.all(reviews.map(async review => {
        let status = review.error ? 'Invalid guide' : '';
        let scope = '';
        if (review.guide) {
          try {
            const snapshot = await snapshotForGuide(root, review.guide);
            const states = allSteps(review.guide).map(step => stepState(step, snapshot, review.guide!.base));
            status = `${states.filter(state => state === 'reviewed').length}/${states.length} reviewed`;
            const stale = states.filter(state => state === 'stale').length;
            if (stale) status += ` · ${stale} stale`;
            scope = scopeLabel(snapshot);
          } catch { status = 'Unavailable comparison'; }
        }
        return { label: review.guide?.title ?? review.file, description: `${review.file} · ${status}`, detail: scope || review.error, file: review.file };
      }));
      file = (await vscode.window.showQuickPick(choices, { title: 'Switch review', matchOnDescription: true, matchOnDetail: true }))?.file;
    }
    if (!file || this.root !== root) return;
    if (!reviews.some(review => review.file === file)) throw new Error('Choose an existing review inside .agr/.');
    await this.mutation;
    this.resetReview(file);
    await this.context.workspaceState.update(`agr.review:${root}`, file);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
      do { this.refreshAgain = false; await this.refreshOnce(); } while (this.refreshAgain);
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }
  private async refreshOnce(): Promise<void> {
    const generation = ++this.generation;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to read its Git changes.');
      if (!this.root) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const saved = this.context.workspaceState.get<string>('agr.root');
        this.root = saved && folders.some(f => saved === f.uri.fsPath || f.uri.fsPath.startsWith(saved + path.sep))
          ? saved : folders[0] ? await repositoryRoot(folders[0].uri.fsPath) : undefined;
      }
      if (!this.root) { this.items = []; this.view.message = 'Open a Git repository to begin.'; this.changed.fire(); return; }
      const reviews = await listReviews(this.root);
      if (generation !== this.generation) return;
      this.reviews = reviews;
      const saved = this.context.workspaceState.get<string>(`agr.review:${this.root}`);
      const file = reviews.find(review => review.file === (this.reviewFile ?? saved))?.file ?? reviews[0]?.file;
      if (file !== this.reviewFile) {
        this.resetReview(file);
        await this.context.workspaceState.update(`agr.review:${this.root}`, file);
        this.refreshAgain = true;
        return;
      }
      const selected = reviews.find(review => review.file === file);
      let guide = selected?.guide;
      this.guide = guide;
      this.view.title = guide?.title ?? 'AGR';
      this.view.description = file;
      if (selected?.error) throw new Error(`Guide error in .agr/${file}: ${selected.error}`);
      const snapshot = await snapshotForGuide(this.root, guide);
      if (generation !== this.generation) return;
      if (guide && file) {
        const root = this.root;
        const previous = guide;
        const split = nestGuide(guide, snapshot);
        if (split !== guide) {
          const migration = this.mutation.then(async () => {
            if (generation !== this.generation) return false;
            const uri = vscode.Uri.file(await reviewPath(root!, file));
            const document = await vscode.workspace.openTextDocument(uri);
            if (document.isDirty) throw new Error('Save the guide before AGR upgrades its structure.');
            const saved = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
            if (JSON.stringify(parseGuide(saved)) !== JSON.stringify(previous)) { this.refreshAgain = true; return false; }
            if (document.isDirty || generation !== this.generation) return false;
            if (Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') !== saved) { this.refreshAgain = true; return false; }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeGuide(split)));
            return true;
          });
          this.mutation = migration.then(() => {}, () => {});
          if (!await migration || generation !== this.generation) return;
          guide = split;
          if (selected) selected.guide = split;
        }
      }
      this.snapshot = snapshot; this.guide = guide;
      this.items = [];
      const changes = new Map(snapshot.changes.map(c => [c.id, c]));
      let reviewed = 0;
      if (guide) {
        for (const [index, group] of guide.groups.entries()) {
          const parent = new Item(`${index + 1} ${group.title.replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, '')}`);
          parent.id = `${this.reviewFile}:${group.id}`;
          parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
          const leaves = group.steps.map(step => {
            const state = stepState(step, snapshot, guide.base);
            if (state === 'reviewed') reviewed++;
            const item = new Item(step.title, step, undefined, this.reviewKey);
            item.id = `${this.reviewFile}:${step.id}`; item.contextValue = 'step';
            const files = [...new Set(step.changes.map(id => changes.get(id)?.file).filter(Boolean))] as string[];
            item.label = files.length === 1 ? path.basename(files[0]) : step.title;
            item.description = state === 'stale' ? 'Needs another look' : `${files.length === 1 && path.dirname(files[0]) !== '.' ? path.dirname(files[0]) : ''}${step.optional ? ' · optional' : ''}`;
            const tooltip = new vscode.MarkdownString();
            appendReviewText(tooltip, step.note);
            if (step.focus) appendReviewText(tooltip.appendMarkdown('\n\n'), `Check: ${step.focus}`);
            appendReviewText(tooltip.appendMarkdown('\n\n'), files.join('\n'));
            item.tooltip = tooltip;
            item.checkboxState = state === 'reviewed' ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
            item.iconPath = new vscode.ThemeIcon(state === 'stale' ? 'warning' : state === 'reviewed' ? 'pass' : 'circle-outline');
            item.command = { command: 'agr.open', title: 'Open Step', arguments: [item] };
            return item;
          });
          const changeGroups = new Map<string, Item>();
          for (const leaf of leaves) {
            const step = leaf.step!;
            const title = step.changeGroup?.title ?? step.title;
            const key = step.changeGroup?.id ?? step.id;
            let changeGroup = changeGroups.get(key);
            if (!changeGroup) {
              changeGroup = new Item(`${index + 1}.${changeGroups.size + 1} ${title}`);
              changeGroup.id = `${parent.id}:change:${key}`;
              changeGroup.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
              changeGroups.set(key, changeGroup);
            }
            changeGroup.children.push(leaf);
          }
          parent.children = [...changeGroups.values()];
          this.items.push(parent);
        }
      } else {
        const setup = new Item('Install skills for Claude Code and Codex');
        setup.iconPath = new vscode.ThemeIcon('sparkle');
        setup.command = { command: 'agr.installSkill', title: 'Install skills' };
        this.items.push(setup);
      }
      const uncovered = uncoveredChanges(guide, snapshot);
      if (uncovered.length) {
        const parent = new Item(`Unguided changes (${uncovered.length})`);
        parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        parent.iconPath = new vscode.ThemeIcon('warning');
        parent.children = uncovered.map(change => {
          const item = new Item(`${path.basename(change.file)} · ${change.kind === 'text' ? `L${change.newLines ? change.newStart : change.oldStart}` : change.kind}`, undefined, change, this.reviewKey);
          item.description = path.dirname(change.file);
          item.tooltip = change.file;
          item.command = { command: 'agr.open', title: 'Open Change', arguments: [item] };
          return item;
        });
        this.items.push(parent);
      }
      if (guide?.pullRequestUrl) {
        const pr = parsePullRequest(guide.pullRequestUrl);
        const link = new Item(`Open PR #${pr.number}`);
        link.contextValue = 'prLink'; link.iconPath = new vscode.ThemeIcon('github');
        link.tooltip = guide.pullRequestUrl;
        link.command = { command: 'agr.openPullRequest', title: 'Open PR' };
        const comments = new Item('Load GitHub comments');
        comments.contextValue = 'githubComments'; comments.iconPath = new vscode.ThemeIcon('comment-discussion');
        comments.command = { command: 'agr.loadComments', title: 'Load GitHub comments' };
        this.items.unshift(link, comments);
      }
      if (guide) {
        const overview = new Item('Review overview');
        overview.id = `${this.reviewFile}:overview`;
        overview.contextValue = 'overview';
        overview.iconPath = new vscode.ThemeIcon('info');
        overview.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        const scope = new Item('Scope');
        scope.description = scopeLabel(snapshot);
        scope.tooltip = scopeLabel(snapshot);
        overview.children.push(scope);
        if (guide.summary) {
          const summary = new Item('Read summary');
          const tooltip = new vscode.MarkdownString(guide.summary);
          tooltip.isTrusted = false; tooltip.supportHtml = false;
          summary.tooltip = tooltip;
          summary.command = { command: 'agr.showOverview', title: 'Read review summary' };
          overview.children.push(summary);
        }
        this.items.unshift(overview);
      }
      this.view.title = guide?.title ?? 'AGR';
      this.view.message = guide
        ? this.header(guide, snapshot, reviewed)
        : 'Ask your agent to create .agr/<name>.json using the agr skill.';
      this.changed.fire();
      if (this.view.visible) void this.offerGitHubSync();
    } catch (error) {
      if (generation !== this.generation) return;
      this.snapshot = undefined;
      this.threads.forEach(thread => thread.dispose()); this.threads = [];
      this.highlights.clear(); this.decorate();
      this.items = this.guide?.groups.map((group, index) => {
        const parent = new Item(`${index + 1} ${group.title.replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, '')}`);
        parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        const changeGroups = new Map<string, Item>();
        for (const step of group.steps) {
          const key = step.changeGroup?.id ?? step.id;
          let change = changeGroups.get(key);
          if (!change) {
            change = new Item(`${index + 1}.${changeGroups.size + 1} ${step.changeGroup?.title ?? step.title}`);
            change.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            changeGroups.set(key, change);
          }
          const item = new Item(step.file ? path.basename(step.file) : step.title);
          item.description = 'Unavailable';
          const note = new vscode.MarkdownString();
          appendReviewText(note, step.note + (step.focus ? `\n\nCheck: ${step.focus}` : ''));
          item.tooltip = note; item.iconPath = new vscode.ThemeIcon('warning');
          change.children.push(item);
        }
        parent.children = [...changeGroups.values()];
        return parent;
      }) ?? [];
      this.view.message = `Review unavailable: ${(error as Error).message}\nOpen the guide to read its notes, or switch reviews. Fetch missing commits or ask your agent to refresh this review.`;
      this.changed.fire();
    }
  }

  private header(guide: Guide, snapshot: Snapshot, count: number): string {
    const missing = uncoveredChanges(guide, snapshot).length;
    const excerpt = guide.summary ? summaryExcerpt(guide.summary) : '';
    return `${this.progressLabel(count, allSteps(guide).length)}${missing ? ` · ${missing} unguided` : ''}${excerpt ? `\n\n${excerpt}\n\n` : ''}`;
  }
  showOverview(): void {
    if (!this.guide || !this.snapshot) throw new Error('Open a review first.');
    const panel = vscode.window.createWebviewPanel('agr.overview', 'AGR review overview', vscode.ViewColumn.Beside, { enableScripts: false, localResourceRoots: [] });
    panel.webview.html = overviewHtml(this.guide.title, scopeLabel(this.snapshot), this.guide.summary ?? '');
    this.context.subscriptions.push(panel);
  }
  async openPullRequest(): Promise<void> {
    const url = this.guide?.pullRequestUrl;
    if (!url) throw new Error('This guide has no PR URL.');
    parsePullRequest(url);
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
  async loadComments(): Promise<void> {
    const guide = this.guide, root = this.root, file = this.reviewFile, epoch = this.epoch;
    if (!guide || !root || !file || !guide.pullRequestUrl) throw new Error('Open a PR guide with pullRequestUrl before loading comments.');
    const signature = (g: Guide) => JSON.stringify([g.base, g.scope, g.pullRequestUrl]);
    const current = async () => {
      if (this.disposed || !vscode.workspace.isTrusted || this.epoch !== epoch || !this.guide || signature(this.guide) !== signature(guide)) return false;
      try { return signature(parseGuide(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(await reviewPath(root, file)))).toString('utf8'))) === signature(guide); } catch { return false; }
    };
    await this.githubComments.load({ gh: this.githubClient(root), pr: parsePullRequest(guide.pullRequestUrl), guide, current });
  }

  private progressLabel(reviewed: number, total: number): string {
    const filled = total && reviewed ? (reviewed === total ? 10 : Math.max(1, Math.min(9, Math.round(reviewed / total * 10)))) : 0;
    return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${total ? Math.round(reviewed / total * 100) : 0}% · ${reviewed} / ${total} reviewed`;
  }

  private virtual(file: string, side: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'agr', path: '/' + side + '/' + file, query: hash(content) });
    this.documents.set(uri.toString(), content);
    return uri;
  }
  private range(start: number, count: number, content: string): vscode.Range {
    const last = Math.max(0, content.split('\n').length - 1);
    const first = Math.max(0, Math.min(last, start - 1));
    return new vscode.Range(first, 0, Math.min(last, first + Math.max(count, 1) - 1), Number.MAX_SAFE_INTEGER);
  }
  private decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.decoration, this.highlights.get(editor.document.uri.toString()) ?? []);
  }
  async open(item?: Item): Promise<void> {
    if (!item) item = this.activeItem ?? this.treeItems().find(i => i.step?.id === this.activeId);
    if (!item || (!item.step && !item.change)) return;
    if (item.reviewFile !== this.reviewKey) throw new Error('The active review changed. Select a step in the current review.');
    const epoch = this.epoch, request = ++this.openRequest;
    const isCurrent = () => !this.disposed && epoch === this.epoch && request === this.openRequest;
    if (!this.snapshot) await this.refresh();
    if (!isCurrent()) return;
    if (!this.snapshot || !this.root) throw new Error('Could not read current Git changes.');
    const step = item.step && this.guide ? allSteps(this.guide).find(s => s.id === item!.step!.id) : undefined;
    const ids = step?.changes ?? (item.change ? [item.change.id] : []);
    const requestedFiles = [...new Set(this.snapshot.changes.filter(c => ids.includes(c.id)).map(c => c.file))];
    // Opening a step must not wait for every unrelated file to be scanned.
    // Revalidate its files so anchors still refer to the code being displayed.
    const current = await snapshotForGuide(this.root, this.guide, requestedFiles);
    if (!isCurrent()) return;
    const selected = step ? selectedChanges(step, current) : item.change && current.changes.some(c => c.id === item!.change!.id) ? [item.change] : [];
    if (selected.length !== ids.length || !ids.length || (step && this.guide?.base !== current.base)) {
      throw new Error('This step is out of date. Ask your agent to regenerate the guide; current changes are listed under Unguided changes.');
    }
    const files = [...new Map(selected.map(c => [JSON.stringify([c.comparisonId, c.file]), c])).values()];
    if (files.length !== 1) throw new Error('This entry still covers multiple files. Refresh the review to split it, or regenerate it if its changes are stale.');
    const representative = files[0];
    if (!isCurrent()) return;
    const file = representative.file;
    const [before, after] = await Promise.all([changeContent(this.root, current, representative, 'original'), changeContent(this.root, current, representative, 'modified')]);
    if (!isCurrent()) return;
    const changes = selected.filter(c => c.file === file && c.comparisonId === representative.comparisonId);
    if (changes.some(c => c.kind === 'binary')) {
      void vscode.window.showInformationMessage(`${file}: binary change. Review this file with an appropriate viewer, then mark the step reviewed.`);
      return;
    }
    const comparison = current.scope?.comparisons.find(c => c.id === representative.comparisonId);
    const leftLabel = comparison ? `${comparison.id}/${comparison.kind === 'unstaged' ? 'Index' : comparison.base?.slice(0, 8) ?? 'Empty'}` : 'HEAD';
    const rightLabel = comparison ? `${comparison.id}/${comparison.kind === 'staged' ? 'Index' : comparison.head?.slice(0, 8) ?? 'Working-tree'}` : 'Working-tree';
    const left = this.virtual(file, `full/${leftLabel}`, before);
    const right = this.virtual(file, `full/${rightLabel}`, after);
    const original = changes.filter(c => c.oldLines > 0).map(c => this.range(c.oldStart, c.oldLines, before));
    const modified = changes.filter(c => c.newLines > 0).map(c => this.range(c.newStart, c.newLines, after));
    const first = changes[0];
    const target = first.newLines ? this.range(first.newStart, first.newLines, after) : this.range(first.newStart || 1, 1, after);
    const fingerprint = step ? stepFingerprint(step, current) : undefined;
    const rendered = JSON.stringify([left.toString(), right.toString(), fingerprint, changes]);
    const transition = this.openTransition.then(async () => {
      if (!isCurrent()) return;
      this.activeId = step?.id; this.activeItem = item;
      if (step && fingerprint) this.openedFingerprints.set(step.id, fingerprint);
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (this.renderedDiff === rendered && input instanceof vscode.TabInputTextDiff && input.original.toString() === left.toString() && input.modified.toString() === right.toString()) return;
      const oldThreads = this.threads;
      const oldHighlights = this.highlights;
      const nextThreads: vscode.CommentThread[] = [];
      if (step) {
        const isDeletion = first.newLines === 0 && first.oldLines > 0;
        const body = new vscode.MarkdownString();
        appendReviewText(body, step.note);
        if (step.focus) appendReviewText(body.appendMarkdown('\n\n'), `Check: ${step.focus}`);
        if (changes.some(c => c.kind === 'metadata')) appendReviewText(body.appendMarkdown('\n\n'), changes.filter(c => c.kind === 'metadata').map(c => c.patch).join('\n'));
        const anchor = isDeletion ? original[0].start : target.start;
        const thread = this.comments.createCommentThread(isDeletion ? left : right, new vscode.Range(anchor, anchor), [{ body, mode: vscode.CommentMode.Preview, author: { name: 'AGR' } }]);
        thread.label = step.title; thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        nextThreads.push(thread);
      }
      // Prepare annotations before displaying the new editor. Keep the old
      // view intact during Git reads and dispose its annotations only after switching.
      this.threads = [...oldThreads, ...nextThreads];
      this.highlights = new Map(oldHighlights);
      this.highlights.set(left.toString(), original); this.highlights.set(right.toString(), modified);
      try {
        await vscode.commands.executeCommand('vscode.diff', left, right, `${step?.title ?? 'Unguided change'} — ${path.basename(file)} (full diff)${comparison ? ` [${comparison.title ?? comparison.id}]` : ''}`, { preview: true, selection: new vscode.Range(target.start, target.start) });
        if (epoch !== this.epoch || this.disposed) { nextThreads.forEach(t => t.dispose()); return; }
        oldThreads.forEach(t => t.dispose());
        this.threads = nextThreads;
        this.highlights = new Map([[left.toString(), original], [right.toString(), modified]]);
        this.renderedDiff = rendered;
        this.githubComments.attach(file, left, right, before, after, current.changes.filter(c => c.file === file && c.comparisonId === representative.comparisonId), this.guide);
        this.decorate();
      } catch (error) {
        nextThreads.forEach(t => t.dispose());
        if (epoch === this.epoch && !this.disposed) { this.threads = oldThreads; this.highlights = oldHighlights; this.decorate(); }
        throw error;
      }
    });
    this.openTransition = transition.catch(() => {});
    await transition;
  }

  runToggle(item?: Item, desired?: boolean): void {
    void this.toggle(item, desired).catch(async error => {
      void vscode.window.showErrorMessage((error as Error).message);
      await this.refresh();
    });
  }
  async toggle(item?: Item, desired?: boolean): Promise<void> {
    if (item && item.reviewFile !== this.reviewKey) throw new Error('The active review changed.');
    const id = item?.step?.id ?? this.activeId;
    const root = this.root, file = this.reviewFile, epoch = this.epoch;
    const current = this.treeItems().find(entry => entry.step?.id === id);
    if (!id || !current || !root || !file) return;
    const reviewed = desired ?? !(this.pendingReviews.get(id)?.reviewed ?? (current.checkboxState === vscode.TreeItemCheckboxState.Checked));
    const token = Symbol(id);
    this.pendingReviews.set(id, { token, reviewed });
    this.changed.fire();
    const result = this.mutation.then(() => this.toggleOnce(current, reviewed, root, file, epoch)).finally(() => {
      if (this.pendingReviews.get(id)?.token === token) this.pendingReviews.delete(id);
      this.changed.fire();
    });
    this.mutation = result.catch(() => {});
    return result;
  }
  private async toggleOnce(item: Item, desired: boolean, root: string, file: string, epoch: number): Promise<void> {
    const id = item?.step?.id ?? this.activeId;
    if (!id || epoch !== this.epoch) throw new Error('The active review changed.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(await reviewPath(root, file)));
    if (document.isDirty) throw new Error('Save the guide file before changing review progress.');
    // Agents write this file outside the editor. Its saved content may be newer
    // than an already-open text document while VS Code's file watcher catches up.
    const savedText = Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8');
    const guide = parseGuide(savedText);
    const step = allSteps(guide).find(s => s.id === id);
    if (!step) throw new Error('This step was removed. Refresh the guide.');
    const known = this.snapshot?.changes.filter(change => step.changes.includes(change.id)) ?? [];
    const files = known.length === step.changes.length ? [...new Set(known.map(change => change.file))] : undefined;
    const snapshot = await snapshotForGuide(root, guide, files);
    if (epoch !== this.epoch) throw new Error('The active review changed.');
    const reviewed = desired ?? stepState(step, snapshot, guide.base) !== 'reviewed';
    if (reviewed) {
      if (guide.base !== snapshot.base || selectedChanges(step, snapshot).length !== step.changes.length) throw new Error('The code in this step changed. Regenerate the guide before marking it reviewed.');
      const fingerprint = stepFingerprint(step, snapshot);
      const opened = this.openedFingerprints.get(step.id);
      if (opened && opened !== fingerprint) throw new Error('This step changed since you opened it. Open its diff again before marking it reviewed.');
      step.review = { status: 'reviewed', fingerprint, reviewedAt: new Date().toISOString() };
    } else step.review = { status: 'pending' };
    // A clean document may reload our previous save while another toggle is
    // queued. Only unsaved edits or changed disk content represent a conflict.
    if (document.isDirty) throw new Error('The guide changed while updating progress. Try again.');
    if (Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString('utf8') !== savedText) throw new Error('The guide changed while updating progress. Try again.');
    // Write the saved artifact directly: an agent may have updated it while an
    // editor still has an older disk timestamp. Never dirty a stale editor buffer.
    await vscode.workspace.fs.writeFile(document.uri, Buffer.from(serializeGuide(guide)));
    if (epoch !== this.epoch) return;
    this.generation++;
    this.guide = guide;
    const current = this.treeItems().find(entry => entry.step?.id === id);
    if (current) {
      current.step = step;
      current.checkboxState = reviewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      current.iconPath = new vscode.ThemeIcon(reviewed ? 'pass' : 'circle-outline');
      current.description = `${[...new Set(snapshot.changes.filter(change => step.changes.includes(change.id)).map(change => path.dirname(change.file) === '.' ? '' : path.dirname(change.file)))].join(', ')}${step.optional ? ' · optional' : ''}`;
    }
    if (this.snapshot && this.snapshot.base === snapshot.base) {
      const count = allSteps(guide).filter(entry => stepState(entry, this.snapshot!, guide.base) === 'reviewed').length;
      this.view.message = this.header(guide, this.snapshot, count);
    }
    this.changed.fire();
    this.schedule();
    this.queueGitHub(root, file, [...new Set(snapshot.changes.filter(c => step.changes.includes(c.id)).map(c => c.file))]);
  }
  private githubKey(root: string, file: string): string { return `agr.github:${path.join(root, '.agr', file)}`; }
  private notifyOutdated(error: OutdatedReviewError, root: string, file: string): void {
    const noticeKey = JSON.stringify([root, file, error.message]);
    if (this.root === root && this.reviewFile === file) {
      this.githubStatus.text = '$(warning) AGR: Review outdated';
      this.githubStatus.tooltip = error.message;
      this.githubStatus.show();
    }
    if (this.outdatedNotices.has(noticeKey)) return;
    this.outdatedNotices.add(noticeKey);
    void vscode.window.showWarningMessage(error.message, 'Open Guide', 'Open PR').then(async action => {
      if (action === 'Open Guide') await vscode.window.showTextDocument(vscode.Uri.file(await reviewPath(root, file)));
      if (action === 'Open PR') await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${error.pr.repo}/pull/${error.pr.number}`));
    }).then(undefined, error => { void vscode.window.showErrorMessage((error as Error).message); });
  }
  private githubChoiceKey(root: string, file: string, url: string): string {
    return `${this.githubKey(root, file)}:choice:${url.replace(/\/$/, '')}`;
  }
  private async offerGitHubSync(): Promise<void> {
    const root = this.root, file = this.reviewFile, guide = this.guide, epoch = this.epoch;
    if (!root || !file || !guide?.pullRequestUrl || !this.snapshot || this.disposed || !vscode.workspace.isTrusted || this.githubPromptPending || this.manualGitHubConnection) return;
    try { prComparison(guide); } catch { return; }
    const pr = parsePullRequest(guide.pullRequestUrl);
    const key = this.githubKey(root, file);
    const choiceKey = this.githubChoiceKey(root, file, guide.pullRequestUrl);
    const promptKey = JSON.stringify([choiceKey, guide.base]);
    const binding = this.context.workspaceState.get<{ pr: PullRequest; base: string }>(key);
    if (binding?.base === guide.base && binding.pr.repo === pr.repo && binding.pr.number === pr.number) return;
    if (this.context.workspaceState.get(choiceKey) === 'local' || this.githubPrompts.has(promptKey)) return;
    this.githubPrompts.add(promptKey);
    this.githubPromptPending = true;
    try {
      const action = await this.askGitHubSync(guide.pullRequestUrl);
      if (this.disposed || epoch !== this.epoch || this.guide?.base !== guide.base || this.guide?.pullRequestUrl !== guide.pullRequestUrl) return;
      if (action === 'Keep local') {
        await this.context.workspaceState.update(key, undefined);
        await this.context.workspaceState.update(choiceKey, 'local');
      } else if (action === 'Enable sync') await this.enableGitHub(root, file, guide, pr);
    } catch (error) {
      void vscode.window.showWarningMessage(`${(error as Error).message} Use AGR: Connect GitHub PR to try again.`);
    } finally {
      this.githubPromptPending = false;
      if (!this.disposed && this.view.visible && epoch !== this.epoch) void this.offerGitHubSync();
    }
  }
  private async enableGitHub(root: string, file: string, guide: Guide, pr: PullRequest): Promise<void> {
    const epoch = this.epoch;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking GitHub PR…' }, () => remoteReview(this.githubClient(root), pr, guide));
    } catch (error) {
      if (error instanceof OutdatedReviewError) { this.notifyOutdated(error, root, file); return; }
      throw error;
    }
    if (this.disposed || !vscode.workspace.isTrusted || epoch !== this.epoch || root !== this.root || file !== this.reviewFile || guide.base !== this.guide?.base || guide.pullRequestUrl !== this.guide?.pullRequestUrl) throw new Error('The active review changed. Connect it again.');
    await this.context.workspaceState.update(this.githubKey(root, file), { pr, base: guide.base });
    if (guide.pullRequestUrl) await this.context.workspaceState.update(this.githubChoiceKey(root, file, guide.pullRequestUrl), 'enabled');
    this.queueGitHub(root, file);
    void vscode.window.showInformationMessage('GitHub sync enabled for this review. Fully reviewed files will be marked Viewed.');
  }
  async connectGitHub(): Promise<void> {
    if (this.manualGitHubConnection) return;
    this.manualGitHubConnection = true;
    try { await this.connectGitHubOnce(); } finally { this.manualGitHubConnection = false; }
  }
  private async connectGitHubOnce(): Promise<void> {
    await this.refresh();
    const root = this.root, file = this.reviewFile, guide = this.guide;
    if (!root || !file || !guide) throw new Error('Open a PR review guide first.');
    prComparison(guide);
    const url = await vscode.window.showInputBox({ title: 'Connect GitHub PR', prompt: 'Enable AGR → GitHub Viewed sync for this review using your gh login.', value: guide.pullRequestUrl, placeHolder: 'https://github.com/owner/repo/pull/123', ignoreFocusOut: true });
    if (!url) return;
    const pr = parsePullRequest(url);
    if (guide.pullRequestUrl && JSON.stringify(pr) !== JSON.stringify(parsePullRequest(guide.pullRequestUrl))) throw new Error('This URL differs from the guide’s PR. Update the guide’s pullRequestUrl first.');
    if (root !== this.root || file !== this.reviewFile || guide.base !== this.guide?.base || guide.pullRequestUrl !== this.guide?.pullRequestUrl) throw new Error('The active review changed. Connect it again.');
    await this.enableGitHub(root, file, guide, pr);
  }
  async disconnectGitHub(): Promise<void> {
    if (this.root && this.reviewFile) {
      await this.context.workspaceState.update(this.githubKey(this.root, this.reviewFile), undefined);
      if (this.guide?.pullRequestUrl) await this.context.workspaceState.update(this.githubChoiceKey(this.root, this.reviewFile, this.guide.pullRequestUrl), 'local');
    }
    this.githubStatus.hide();
    void vscode.window.showInformationMessage('GitHub sync disconnected. Existing GitHub Viewed flags are unchanged.');
  }
  private queueGitHub(root: string, file: string, affected?: string[]): void {
    const key = this.githubKey(root, file);
    const binding = this.context.workspaceState.get<{ pr: PullRequest; base: string }>(key);
    if (!binding) return;
    const bindingText = JSON.stringify(binding);
    const connected = () => !this.disposed && vscode.workspace.isTrusted && JSON.stringify(this.context.workspaceState.get(key)) === bindingText;
    const showStatus = (text: string) => {
      if (this.root !== root || this.reviewFile !== file || !connected()) return;
      this.githubStatus.text = text;
      this.githubStatus.tooltip = `AGR → ${binding.pr.repo}#${binding.pr.number}`;
      this.githubStatus.show();
    };
    this.githubQueue = this.githubQueue.then(async () => {
      if (!connected()) return;
      showStatus('$(sync~spin) AGR: Syncing GitHub');
      const uri = vscode.Uri.file(await reviewPath(root, file));
      const read = async () => Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const text = await read();
      const guide = parseGuide(text);
      if (guide.pullRequestUrl && JSON.stringify(parsePullRequest(guide.pullRequestUrl)) !== JSON.stringify(binding.pr)) throw new Error('The guide now references a different PR. Connect that PR before syncing.');
      if (guide.base !== binding.base) throw new Error('This guide changed its comparison. Reconnect the PR to enable sync again.');
      const snapshot = await snapshotForGuide(root, guide);
      await syncFiles(this.githubClient(root), binding.pr, guide, snapshot, affected, async () => {
        if (!connected()) return false;
        if (await read() !== text) throw new Error('AGR_SYNC_SUPERSEDED');
        return true;
      });
      showStatus('$(github) AGR: GitHub synced');
    }).catch(error => {
      if (!connected()) return;
      if ((error as Error).message === 'AGR_SYNC_SUPERSEDED') { this.queueGitHub(root, file, affected); return; }
      if (error instanceof OutdatedReviewError) { this.notifyOutdated(error, root, file); return; }
      showStatus('$(warning) AGR: GitHub sync failed');
      void vscode.window.showWarningMessage(`AGR progress is saved locally. ${(error as Error).message}`, 'Retry').then(action => {
        if (action === 'Retry' && connected()) this.queueGitHub(root, file, affected);
      });
    });
  }
  async navigate(direction: number): Promise<void> {
    const steps = this.treeItems().filter(i => i.step);
    const index = steps.findIndex(i => i.step?.id === this.activeId);
    const next = steps[index < 0 ? (direction > 0 ? 0 : steps.length - 1) : index + direction];
    if (!next) return;
    await this.open(next);
    const current = this.treeItems().find(i => i.step?.id === next.step?.id);
    if (!current || !this.view.visible) return;
    const parent = this.getParent(current);
    if (parent) {
      const section = this.getParent(parent);
      if (section) await this.view.reveal(section, { expand: true });
      await this.view.reveal(parent, { expand: true });
    }
    await this.view.reveal(current, { select: true });
  }
  async edit(): Promise<void> {
    if (!this.root) throw new Error('Open a Git repository first.');
    if (!this.reviewFile) throw new Error('Create .agr/<name>.json first.');
    await vscode.window.showTextDocument(vscode.Uri.file(await reviewPath(this.root, this.reviewFile)));
  }
  async exportSnapshot(): Promise<void> {
    await this.refresh();
    if (!this.snapshot || !this.root) throw new Error('Open a Git repository first.');
    const directory = path.join(this.root, '.agr', '.cache');
    await mkdir(directory, { recursive: true });
    const uri = vscode.Uri.file(path.join(directory, `${this.reviewFile?.slice(0, -5) ?? 'uncommitted'}.snapshot.json`));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(this.snapshot, null, 2) + '\n'));
    await vscode.window.showTextDocument(uri);
  }
  async installSkill(scope?: InstallScope): Promise<void> {
    if (!scope) {
      const choice = await vscode.window.showQuickPick([
        { label: 'Globally', description: 'Available across your projects', scope: 'global' as const,
          detail: skillTargets('global', undefined, homedir(), process.env.CLAUDE_CONFIG_DIR).join(' • ') },
        { label: 'This repository', description: 'Only for the selected Git repository', scope: 'repository' as const,
          detail: '.agents/skills/agr and .claude/skills/agr in the repository root' }
      ], { title: 'Where should AGR install the agent skills?', placeHolder: 'Choose an installation location for Claude Code and Codex' });
      if (!choice) return;
      scope = choice.scope;
    }
    if (scope === 'repository') await this.refresh();
    const targets = skillTargets(scope, this.root, homedir(), process.env.CLAUDE_CONFIG_DIR);
    await installSkills(this.context.asAbsolutePath('dist/skill'), targets);
    void vscode.window.showInformationMessage(`Installed AGR skills ${scope === 'global' ? 'globally' : 'in this repository'}: ${targets.join(' and ')}. Start a fresh agent session to use them.`);
  }
  private installedSkillTargets(): string[] {
    return [...skillTargets('global', undefined, homedir(), process.env.CLAUDE_CONFIG_DIR),
      ...(this.root ? skillTargets('repository', this.root, homedir()) : [])];
  }
  async offerSkillUpdates(manual = false): Promise<void> {
    if (this.disposed || this.skillUpdatePending || !vscode.workspace.isTrusted) return;
    this.skillUpdatePending = true;
    try {
      const source = this.context.asAbsolutePath('dist/skill');
      const { digest, updates, skipped } = await outdatedSkills(source, this.installedSkillTargets());
      if (this.disposed) return;
      if (manual && skipped.length) void vscode.window.showWarningMessage(skipped.join('\n'));
      const unseen = updates.filter(u => this.context.globalState.get(`agr.skillNotice:${u.target}`) !== digest);
      if (!manual && !unseen.length) return;
      if (!updates.length) {
        if (manual) void vscode.window.showInformationMessage('No outdated AGR skills found. Use AGR: Install Agent Skills to add missing copies.');
        return;
      }
      if (!manual) {
        for (const update of unseen) await this.context.globalState.update(`agr.skillNotice:${update.target}`, digest);
        const action = await vscode.window.showInformationMessage('AGR includes updated agent skills. Update your installed copies for the current review format?', 'Update Skills', 'Not Now');
        if (action !== 'Update Skills' || this.disposed) return;
      }
      const selected = await vscode.window.showQuickPick(updates.map(update => ({
        label: update.target, picked: true, update,
        description: 'The existing folder will be backed up before replacement.'
      })), { canPickMany: true, title: 'Update AGR skills', placeHolder: 'Select installed copies to replace. Customizations are preserved in backups.' });
      if (!selected?.length || this.disposed || !vscode.workspace.isTrusted) return;
      const backups = await updateInstalledSkills(source, selected.map(s => s.update));
      void vscode.window.showInformationMessage(`Updated ${selected.length} AGR skill copies. Start a fresh agent session. Backups: ${backups.join(', ')}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`AGR skill update: ${(error as Error).message}`);
    } finally { this.skillUpdatePending = false; }
  }
  getState(): { guide?: Guide; snapshot?: Snapshot; items: Item[]; reviewFile?: string; reviews: ReviewFile[] } { return { guide: this.guide, snapshot: this.snapshot, items: this.items, reviewFile: this.reviewFile, reviews: this.reviews }; }
}

export async function activate(context: vscode.ExtensionContext) {
  const app = new Agr(context);
  context.subscriptions.push(app);
  const command = (name: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`agr.${name}`, async (...args) => {
    try { return await handler(...args); } catch (error) { await vscode.window.showErrorMessage((error as Error).message); }
  }));
  command('showOverview', () => app.showOverview());
  command('openPullRequest', () => app.openPullRequest());
  command('loadComments', () => app.loadComments());
  command('refreshComments', () => app.githubComments.refresh());
  command('browseComments', () => app.githubComments.browse());
  command('addComment', () => app.githubComments.add());
  command('postComment', reply => app.githubComments.post(reply));
  command('editComment', comment => app.githubComments.edit(comment));
  command('saveComment', comment => app.githubComments.save(comment));
  command('cancelCommentEdit', comment => app.githubComments.cancel(comment));
  command('refresh', () => app.refresh());
  command('selectReview', () => app.selectReview());
  command('selectRepository', () => app.selectRepository());
  command('open', item => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Opening review step…' }, () => app.open(item)));
  command('toggle', item => app.toggle(item));
  command('next', () => app.navigate(1));
  command('previous', () => app.navigate(-1));
  command('edit', () => app.edit());
  command('snapshot', () => app.exportSnapshot());
  command('connectGitHub', () => app.connectGitHub());
  command('disconnectGitHub', () => app.disconnectGitHub());
  command('installSkill', () => app.installSkill());
  command('updateSkills', () => app.offerSkillUpdates(true));
  // Git events cover index/HEAD changes that do not touch working files.
  const extension = vscode.extensions.getExtension('vscode.git');
  if (extension) {
    const api = (await extension.activate()).getAPI(1);
    const observe = (repo: { state: { onDidChange: (listener: () => void) => vscode.Disposable } }) => context.subscriptions.push(repo.state.onDidChange(() => void app.refresh()));
    api.repositories.forEach(observe);
    context.subscriptions.push(api.onDidOpenRepository(observe));
  }
  await app.refresh();
  if (context.extensionMode !== vscode.ExtensionMode.Test) void app.offerSkillUpdates();
  return app;
}
