import * as vscode from 'vscode';

/**
 * Watches a repository's refs, HEAD and index for on-disk changes and fires a
 * debounced callback so the graph can auto-refresh after external git
 * operations (commits, checkouts, fetches, rebases, etc.).
 *
 * Object writes under .git/objects are deliberately not watched — they churn
 * heavily during operations and never change what the graph displays on their
 * own; the corresponding ref update under .git/refs is what we react to.
 *
 * Note: repositories whose .git is a file (linked worktrees, submodules) point
 * elsewhere for their refs, so this watcher will not fire for them. That is an
 * accepted limitation; a manual refresh still works.
 */
export class RepoWatcher {
  private watchers: vscode.FileSystemWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private repoPath: string | undefined;

  constructor(private readonly onChange: () => void, private readonly debounceMs = 400) {}

  /** Point the watcher at a repo (or `undefined` to stop watching). No-op if unchanged. */
  watch(repoPath: string | undefined) {
    if (repoPath === this.repoPath) return;
    this.repoPath = repoPath;
    this.disposeWatchers();
    if (!repoPath) return;

    const patterns = [
      new vscode.RelativePattern(repoPath, '.git/{HEAD,ORIG_HEAD,MERGE_HEAD,packed-refs,index}'),
      new vscode.RelativePattern(repoPath, '.git/refs/**'),
    ];
    for (const pattern of patterns) {
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      w.onDidChange(() => this.schedule());
      w.onDidCreate(() => this.schedule());
      w.onDidDelete(() => this.schedule());
      this.watchers.push(w);
    }
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, this.debounceMs);
  }

  private disposeWatchers() {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.disposeWatchers();
    this.repoPath = undefined;
  }
}
