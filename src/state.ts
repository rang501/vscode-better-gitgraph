import * as vscode from 'vscode';
import { Repo, Branch, discoverRepos, listBranches, listAuthors, listTags, currentBranch } from './gitService';
import { RepoWatcher } from './repoWatcher';

export const ALL_BRANCHES = '__all__';

export interface Selection {
  repo?: Repo;
  branch: string; // branch name or ALL_BRANCHES
}

export class AppState {
  private _repos: Repo[] = [];
  private _branches: Branch[] = [];
  private _authors: string[] = [];
  private _tags: string[] = [];
  private _currentBranch: string | null = null;
  private _selection: Selection = { branch: ALL_BRANCHES };
  private _branchFilter = '';

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private _onDidChangeBranches = new vscode.EventEmitter<void>();
  readonly onDidChangeBranches = this._onDidChangeBranches.event;

  private _onDidChangeRepos = new vscode.EventEmitter<void>();
  readonly onDidChangeRepos = this._onDidChangeRepos.event;

  private _watcher = new RepoWatcher(() => void this.onWatchedChange());

  get repos() { return this._repos; }
  get branches() { return this._branches; }
  get authors() { return this._authors; }
  get tags() { return this._tags; }
  get currentBranch() { return this._currentBranch; }
  get selection() { return this._selection; }
  get branchFilter() { return this._branchFilter; }

  async refreshRepos() {
    this._repos = await discoverRepos();
    if (!this._selection.repo || !this._repos.find((r) => r.path === this._selection.repo!.path)) {
      this._selection = { repo: this._repos[0], branch: ALL_BRANCHES };
      await this.loadRepoMeta();
    }
    this.updateWatcher();
    this._onDidChangeRepos.fire();
    this._onDidChange.fire();
  }

  async selectRepo(repo: Repo) {
    if (this._selection.repo?.path === repo.path) return;
    this._selection = { repo, branch: ALL_BRANCHES };
    await this.loadRepoMeta();
    this.updateWatcher();
    this._onDidChangeBranches.fire();
    this._onDidChange.fire();
  }

  selectBranch(branch: string) {
    if (this._selection.branch === branch) return;
    this._selection = { ...this._selection, branch };
    this._onDidChange.fire();
  }

  setBranchFilter(filter: string) {
    this._branchFilter = filter;
    void vscode.commands.executeCommand(
      'setContext',
      'betterGitGraph.hasFilter',
      filter.length > 0
    );
    this._onDidChangeBranches.fire();
  }

  async refreshBranches() {
    if (!this._selection.repo) return;
    await this.loadRepoMeta();
    this._onDidChangeBranches.fire();
    this._onDidChange.fire();
  }

  /** Re-evaluate the auto-refresh setting and point the file watcher accordingly. */
  refreshWatcher() {
    this.updateWatcher();
  }

  dispose() {
    this._watcher.dispose();
  }

  private autoRefreshEnabled(): boolean {
    return vscode.workspace.getConfiguration('betterGitGraph').get<boolean>('autoRefresh', true);
  }

  private updateWatcher() {
    this._watcher.watch(this.autoRefreshEnabled() ? this._selection.repo?.path : undefined);
  }

  private async onWatchedChange() {
    if (!this.autoRefreshEnabled()) return;
    await this.refreshBranches();
  }

  private async loadRepoMeta() {
    if (!this._selection.repo) {
      this._branches = [];
      this._authors = [];
      this._tags = [];
      this._currentBranch = null;
      return;
    }
    const repoPath = this._selection.repo.path;
    const [branches, authors, tags, head] = await Promise.all([
      listBranches(repoPath),
      listAuthors(repoPath),
      listTags(repoPath),
      currentBranch(repoPath),
    ]);
    this._branches = branches;
    this._authors = authors;
    this._tags = tags;
    this._currentBranch = head;
  }
}
