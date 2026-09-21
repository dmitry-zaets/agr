import * as vscode from 'vscode';
import { github, parsePullRequest, prComparison, PullRequest, remoteReview, syncFiles } from './githubSync';
import { focusedDiff } from './focusedDiff';
import { appendReviewText } from './commentText';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { installSkills, skillTargets, InstallScope } from './skillInstall';
import { allSteps, Change, Guide, hash, parseGuide, selectedChanges, Snapshot, Step, stepFingerprint, stepState, uncoveredChanges } from '../../packages/core/src/model';
import { git, repositoryRoot } from '../../packages/core/src/git';
import { listReviews, reviewPath, ReviewFile } from '../../packages/core/src/reviews';
import { changeContent, snapshotForGuide, scopeLabel } from '../../packages/core/src/scope';

class Item extends vscode.TreeItem {
  children: Item[] = [];
  constructor(label: string, public step?: Step, public change?: Change, public reviewFile?: string) { super(label); }
}

class Agr implements vscode.TreeDataProvider<Item>, vscode.TextDocumentContentProvider, vscode.Disposable {
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
  private readonly githubPrompts = new Set<string>();
  private githubPromptPending = false;
  private manualGitHubConnection = false;
  private readonly askGitHubSync = (url: string) => vscode.window.showInformationMessage(`Sync reviewed files to this GitHub PR? ${url}`, 'Enable sync', 'Keep local');
  private githubQueue: Promise<void> = Promise.resolve();
  private readonly githubStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private disposed = false;
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
  private activeFileKey?: string;
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
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.threads.forEach(t => t.dispose()); this.disposables.forEach(d => d.dispose()); }
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
  getChildren(item?: Item): Item[] { return item?.children ?? this.items; }
  getParent(item: Item): Item | undefined { return this.items.find(parent => parent.children.includes(item)); }
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
    this.githubStatus.hide();
    this.renderedDiff = undefined;
    this.epoch++; this.generation++;
    this.reviewFile = file; this.guide = undefined; this.snapshot = undefined;
    this.activeId = undefined; this.activeItem = undefined; this.activeFileKey = undefined; this.items = [];
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
      const guide = selected?.guide;
      this.guide = guide;
      this.view.title = guide?.title ?? 'AGR';
      this.view.description = file;
      if (selected?.error) throw new Error(`Guide error in .agr/${file}: ${selected.error}`);
      const snapshot = await snapshotForGuide(this.root, guide);
      if (generation !== this.generation) return;
      this.snapshot = snapshot; this.guide = guide;
      this.items = [];
      const changes = new Map(snapshot.changes.map(c => [c.id, c]));
      let reviewed = 0;
      if (guide) {
        for (const [index, group] of guide.groups.entries()) {
          const parent = new Item(`${index + 1}. ${group.title}`);
          parent.id = `${this.reviewFile}:${group.id}`;
          parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
          parent.children = group.steps.map(step => {
            const state = stepState(step, snapshot, guide.base);
            if (state === 'reviewed') reviewed++;
            const item = new Item(step.title, step, undefined, this.reviewKey);
            item.id = `${this.reviewFile}:${step.id}`; item.contextValue = 'step';
            const files = [...new Set(step.changes.map(id => changes.get(id)?.file).filter(Boolean))] as string[];
            item.description = state === 'stale' ? 'Needs another look' : `${files.map(f => path.basename(f)).join(', ')}${step.optional ? ' · optional' : ''}`;
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
      this.view.title = guide?.title ?? 'AGR';
      this.view.message = guide
        ? `${reviewed} / ${allSteps(guide).length} reviewed · ${uncovered.length} unguided\n${scopeLabel(snapshot)}${guide.summary ? '\n' + guide.summary : ''}`
        : 'Ask your agent to create .agr/<name>.json using the agr skill.';
      this.changed.fire();
      if (this.view.visible) void this.offerGitHubSync();
    } catch (error) {
      if (generation !== this.generation) return;
      this.snapshot = undefined;
      this.threads.forEach(thread => thread.dispose()); this.threads = [];
      this.highlights.clear(); this.decorate();
      this.items = this.guide?.groups.map((group, index) => {
        const parent = new Item(`${index + 1}. ${group.title}`);
        parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        parent.children = group.steps.map(step => {
          const item = new Item(step.title);
          item.description = 'Unavailable';
          const note = new vscode.MarkdownString();
          appendReviewText(note, step.note + (step.focus ? `\n\nCheck: ${step.focus}` : ''));
          item.tooltip = note; item.iconPath = new vscode.ThemeIcon('warning');
          return item;
        });
        return parent;
      }) ?? [];
      this.view.message = `Review unavailable: ${(error as Error).message}\nOpen the guide to read its notes, or switch reviews. Fetch missing commits or ask your agent to refresh this review.`;
      this.changed.fire();
    }
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
  async open(item?: Item, fullDiff = false): Promise<void> {
    if (!item) item = this.activeItem ?? this.items.flatMap(i => i.children).find(i => i.step?.id === this.activeId);
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
    const previousFile = fullDiff && item === this.activeItem ? files.find(c => JSON.stringify([c.comparisonId, c.file]) === this.activeFileKey) : undefined;
    const representative = previousFile ?? (files.length === 1 ? files[0] : (await vscode.window.showQuickPick(
      files.map(change => ({ label: change.file, description: change.comparisonId, change })),
      { title: step?.title ?? 'Choose a file to review', placeHolder: 'Choose a file from this review step' }
    ))?.change);
    if (!representative || !isCurrent()) return;
    const file = representative.file;
    let [before, after] = await Promise.all([changeContent(this.root, current, representative, 'original'), changeContent(this.root, current, representative, 'modified')]);
    if (!isCurrent()) return;
    let changes = selected.filter(c => c.file === file && c.comparisonId === representative.comparisonId);
    if (changes.some(c => c.kind === 'binary')) {
      void vscode.window.showInformationMessage(`${file}: binary change. Review this file with an appropriate viewer, then mark the step reviewed.`);
      return;
    }
    if (!fullDiff) {
      const excerpt = focusedDiff(before, after, changes, current.changes.filter(c => c.file === file && c.comparisonId === representative.comparisonId));
      before = excerpt.before; after = excerpt.after; changes = excerpt.changes;
    }
    const comparison = current.scope?.comparisons.find(c => c.id === representative.comparisonId);
    const leftLabel = comparison ? `${comparison.id}/${comparison.kind === 'unstaged' ? 'Index' : comparison.base?.slice(0, 8) ?? 'Empty'}` : 'HEAD';
    const rightLabel = comparison ? `${comparison.id}/${comparison.kind === 'staged' ? 'Index' : comparison.head?.slice(0, 8) ?? 'Working-tree'}` : 'Working-tree';
    const left = this.virtual(file, `${fullDiff ? 'full' : 'focused'}/${leftLabel}`, before);
    const right = this.virtual(file, `${fullDiff ? 'full' : 'focused'}/${rightLabel}`, after);
    const original = changes.filter(c => c.oldLines > 0).map(c => this.range(c.oldStart, c.oldLines, before));
    const modified = changes.filter(c => c.newLines > 0).map(c => this.range(c.newStart, c.newLines, after));
    const first = changes[0];
    const target = first.newLines ? this.range(first.newStart, first.newLines, after) : this.range(first.newStart || 1, 1, after);
    const fingerprint = step ? stepFingerprint(step, current) : undefined;
    const rendered = JSON.stringify([left.toString(), right.toString(), fingerprint, changes]);
    const transition = this.openTransition.then(async () => {
      if (!isCurrent()) return;
      this.activeId = step?.id; this.activeItem = item;
      this.activeFileKey = JSON.stringify([representative.comparisonId, representative.file]);
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
        await vscode.commands.executeCommand('vscode.diff', left, right, `${step?.title ?? 'Unguided change'} — ${path.basename(file)} (${fullDiff ? 'full diff' : 'selected changes'})${comparison ? ` [${comparison.title ?? comparison.id}]` : ''}`, { preview: true, selection: new vscode.Range(target.start, target.start) });
        if (epoch !== this.epoch || this.disposed) { nextThreads.forEach(t => t.dispose()); return; }
        oldThreads.forEach(t => t.dispose());
        this.threads = nextThreads;
        this.highlights = new Map([[left.toString(), original], [right.toString(), modified]]);
        this.renderedDiff = rendered;
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
    const current = this.items.flatMap(group => group.children).find(entry => entry.step?.id === id);
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
    await vscode.workspace.fs.writeFile(document.uri, Buffer.from(JSON.stringify(guide, null, 2) + '\n'));
    if (epoch !== this.epoch) return;
    this.generation++;
    this.guide = guide;
    const current = this.items.flatMap(group => group.children).find(entry => entry.step?.id === id);
    if (current) {
      current.step = step;
      current.checkboxState = reviewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      current.iconPath = new vscode.ThemeIcon(reviewed ? 'pass' : 'circle-outline');
      current.description = `${[...new Set(snapshot.changes.filter(change => step.changes.includes(change.id)).map(change => path.basename(change.file)))].join(', ')}${step.optional ? ' · optional' : ''}`;
    }
    if (this.snapshot && this.snapshot.base === snapshot.base) {
      const count = allSteps(guide).filter(entry => stepState(entry, this.snapshot!, guide.base) === 'reviewed').length;
      this.view.message = `${count} / ${allSteps(guide).length} reviewed · ${uncoveredChanges(guide, this.snapshot).length} unguided\n${scopeLabel(this.snapshot)}${guide.summary ? '\n' + guide.summary : ''}`;
    }
    this.changed.fire();
    this.schedule();
    this.queueGitHub(root, file, [...new Set(snapshot.changes.filter(c => step.changes.includes(c.id)).map(c => c.file))]);
  }
  private githubKey(root: string, file: string): string { return `agr.github:${path.join(root, '.agr', file)}`; }
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
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking GitHub PR…' }, () => remoteReview(this.githubClient(root), pr, guide));
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
      showStatus('$(warning) AGR: GitHub sync failed');
      void vscode.window.showWarningMessage(`AGR progress is saved locally. ${(error as Error).message}`, 'Retry').then(action => {
        if (action === 'Retry' && connected()) this.queueGitHub(root, file, affected);
      });
    });
  }
  async navigate(direction: number): Promise<void> {
    const steps = this.items.flatMap(i => i.children).filter(i => i.step);
    const index = steps.findIndex(i => i.step?.id === this.activeId);
    const next = steps[index < 0 ? (direction > 0 ? 0 : steps.length - 1) : index + direction];
    if (next) { await this.open(next); const current = this.items.flatMap(i => i.children).find(i => i.step?.id === next.step?.id); if (current) await this.view.reveal(current, { select: true }); }
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
  getState(): { guide?: Guide; snapshot?: Snapshot; items: Item[]; reviewFile?: string; reviews: ReviewFile[] } { return { guide: this.guide, snapshot: this.snapshot, items: this.items, reviewFile: this.reviewFile, reviews: this.reviews }; }
}

export async function activate(context: vscode.ExtensionContext) {
  const app = new Agr(context);
  context.subscriptions.push(app);
  const command = (name: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`agr.${name}`, async (...args) => {
    try { return await handler(...args); } catch (error) { await vscode.window.showErrorMessage((error as Error).message); }
  }));
  command('refresh', () => app.refresh());
  command('selectReview', () => app.selectReview());
  command('selectRepository', () => app.selectRepository());
  command('open', item => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Opening review step…' }, () => app.open(item)));
  command('openFullDiff', item => app.open(item, true));
  command('toggle', item => app.toggle(item));
  command('next', () => app.navigate(1));
  command('previous', () => app.navigate(-1));
  command('edit', () => app.edit());
  command('snapshot', () => app.exportSnapshot());
  command('connectGitHub', () => app.connectGitHub());
  command('disconnectGitHub', () => app.disconnectGitHub());
  command('installSkill', () => app.installSkill());
  // Git events cover index/HEAD changes that do not touch working files.
  const extension = vscode.extensions.getExtension('vscode.git');
  if (extension) {
    const api = (await extension.activate()).getAPI(1);
    const observe = (repo: { state: { onDidChange: (listener: () => void) => vscode.Disposable } }) => context.subscriptions.push(repo.state.onDidChange(() => void app.refresh()));
    api.repositories.forEach(observe);
    context.subscriptions.push(api.onDidOpenRepository(observe));
  }
  await app.refresh();
  return app;
}
