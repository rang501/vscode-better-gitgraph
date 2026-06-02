import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  getLog,
  LogFilters,
  getCommitDetails,
  getCommitFiles,
  getCommitFileDiff,
  branchesContaining,
  CommitFile,
  createTag,
  deleteTag,
  renameTag,
  moveTag,
  checkoutCommit,
  createBranchAt,
  cherryPick,
  revertCommit,
  resetTo,
  ResetMode,
} from './gitService';
import { AppState, ALL_BRANCHES } from './state';
import {
  checkoutBranch,
  pullBranch,
  pushBranch,
  mergeBranch,
  renameBranchAction,
  deleteBranchAction,
} from './branchActions';
import { makeUri } from './contentProvider';

type BranchAction = 'checkout' | 'pull' | 'push' | 'merge' | 'rename' | 'delete';

type InMessage =
  | { type: 'init' }
  | { type: 'query'; filters: ToolbarFilters }
  | { type: 'copy'; text: string }
  | { type: 'openCommit'; hash: string }
  | { type: 'closeDetail' }
  | { type: 'loadDiff'; file: CommitFile }
  | { type: 'openDiff'; file: CommitFile }
  | { type: 'addTag'; hash: string }
  | { type: 'renameTag'; hash: string; tags: string[] }
  | { type: 'deleteTag'; hash: string; tags: string[] }
  | { type: 'moveTag'; hash: string }
  | { type: 'checkoutCommit'; hash: string }
  | { type: 'createBranch'; hash: string }
  | { type: 'cherryPick'; hash: string }
  | { type: 'revert'; hash: string }
  | { type: 'reset'; hash: string }
  | { type: 'branchAction'; action: BranchAction; branch: string };

interface ToolbarFilters {
  author?: string;
  since?: string;
  until?: string;
  limit?: number;
  tag?: string;
  subject?: string;
}

export class GraphPanel {
  private static current: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private lastToolbar: ToolbarFilters = {};
  private detailSha: string | null = null;

  static show(context: vscode.ExtensionContext, state: AppState) {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'betterGitGraph',
      'Better Git Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    GraphPanel.current = new GraphPanel(panel, context, state);
  }

  private constructor(panel: vscode.WebviewPanel, private context: vscode.ExtensionContext, private state: AppState) {
    this.panel = panel;
    this.panel.webview.html = this.render(context);

    this.panel.webview.onDidReceiveMessage(
      (msg: InMessage) => this.handle(msg),
      undefined,
      this.disposables
    );

    this.disposables.push(state.onDidChange(() => this.sendState()));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handle(msg: InMessage) {
    try {
      switch (msg.type) {
        case 'init': {
          this.sendState();
          return;
        }
        case 'query': {
          this.lastToolbar = msg.filters;
          await this.runQuery(msg.filters);
          return;
        }
        case 'copy': {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage(`Copied: ${msg.text}`, 2000);
          return;
        }
        case 'openCommit': {
          await this.loadDetail(msg.hash);
          return;
        }
        case 'closeDetail': {
          this.detailSha = null;
          return;
        }
        case 'loadDiff': {
          await this.loadDiff(msg.file);
          return;
        }
        case 'openDiff': {
          await this.openDiff(msg.file);
          return;
        }
        case 'addTag': {
          await this.handleAddTag(msg.hash);
          return;
        }
        case 'renameTag': {
          await this.handleRenameTag(msg.hash, msg.tags);
          return;
        }
        case 'deleteTag': {
          await this.handleDeleteTag(msg.hash, msg.tags);
          return;
        }
        case 'moveTag': {
          await this.handleMoveTag(msg.hash);
          return;
        }
        case 'checkoutCommit': {
          await this.handleCheckoutCommit(msg.hash);
          return;
        }
        case 'createBranch': {
          await this.handleCreateBranch(msg.hash);
          return;
        }
        case 'cherryPick': {
          await this.handleCherryPick(msg.hash);
          return;
        }
        case 'revert': {
          await this.handleRevert(msg.hash);
          return;
        }
        case 'reset': {
          await this.handleReset(msg.hash);
          return;
        }
        case 'branchAction': {
          await this.handleBranchAction(msg.action, msg.branch);
          return;
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', message });
    }
  }

  private sendState() {
    this.post({
      type: 'state',
      repo: this.state.selection.repo
        ? { name: this.state.selection.repo.name, path: this.state.selection.repo.path }
        : null,
      branch: this.state.selection.branch,
      authors: this.state.authors,
      tags: this.state.tags,
      remoteBranches: this.state.branches.filter((b) => b.isRemote).map((b) => b.name),
    });
    void this.runQuery(this.lastToolbar);
  }

  private async runQuery(toolbar: ToolbarFilters) {
    if (!this.state.selection.repo) {
      this.post({ type: 'commits', commits: [] });
      return;
    }
    const filters: LogFilters = { ...toolbar };
    if (this.state.selection.branch === ALL_BRANCHES) {
      filters.allBranches = true;
    } else {
      filters.branch = this.state.selection.branch;
    }
    if (toolbar.tag) filters.tag = toolbar.tag;
    if (toolbar.subject) filters.subject = toolbar.subject;
    const commits = await getLog(this.state.selection.repo.path, filters);
    this.post({ type: 'commits', commits });
  }

  private async loadDetail(sha: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    this.detailSha = sha;
    try {
      const [details, files, contained] = await Promise.all([
        getCommitDetails(repo.path, sha),
        getCommitFiles(repo.path, sha),
        branchesContaining(repo.path, sha),
      ]);
      if (this.detailSha !== sha) return;
      this.post({ type: 'commit', details, files, contained });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.post({ type: 'commit', error: message });
    }
  }

  private async loadDiff(file: CommitFile) {
    const repo = this.state.selection.repo;
    if (!repo || !this.detailSha) return;
    const sha = this.detailSha;
    try {
      const patch = await getCommitFileDiff(repo.path, sha, file.path, file.oldPath);
      if (this.detailSha !== sha) return;
      this.post({ type: 'diff', file, patch });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.post({ type: 'diff', file, patch: '', error: message });
    }
  }

  private async openDiff(file: CommitFile) {
    const repo = this.state.selection.repo;
    if (!repo || !this.detailSha) return;
    const sha = this.detailSha;
    const parent = `${sha}^`;
    const isAdded = file.status === 'A';
    const isDeleted = file.status === 'D';
    const isRenamed = file.status.startsWith('R');

    const leftRef = isAdded ? 'empty' : parent;
    const leftPath = isRenamed ? file.oldPath! : file.path;
    const rightRef = isDeleted ? 'empty' : sha;
    const rightPath = file.path;

    const left = makeUri(repo.path, leftRef, leftPath);
    const right = makeUri(repo.path, rightRef, rightPath);

    const title = isRenamed
      ? `${file.oldPath} → ${file.path} (${sha.slice(0, 7)})`
      : `${file.path} (${sha.slice(0, 7)})`;

    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  private post(msg: unknown) {
    this.panel.webview.postMessage(msg);
  }

  private render(context: vscode.ExtensionContext): string {
    const mediaDir = path.join(context.extensionUri.fsPath, 'media');
    const html = fs.readFileSync(path.join(mediaDir, 'index.html'), 'utf8');
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js')
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'style.css')
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${this.panel.webview.cspSource} data:`,
      `font-src ${this.panel.webview.cspSource}`,
    ].join('; ');

    return html
      .replace(/{{cspSource}}/g, this.panel.webview.cspSource)
      .replace(/{{csp}}/g, csp)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{script}}/g, scriptUri.toString())
      .replace(/{{style}}/g, styleUri.toString());
  }

  /** Run a git operation with a progress notification, then refresh state. */
  private async runRepoOp(title: string, fn: () => Promise<string>, successMsg?: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    try {
      const out = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        fn,
      );
      const line = successMsg ?? out.trim().split('\n')[0];
      if (line) vscode.window.setStatusBarMessage(line, 4000);
      await this.state.refreshBranches();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`${title} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleCheckoutCommit(hash: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    const short = hash.slice(0, 7);
    const confirm = await vscode.window.showWarningMessage(
      `Checkout commit ${short}? This leaves the repository in 'detached HEAD' state.`,
      { modal: true },
      'Checkout',
    );
    if (confirm !== 'Checkout') return;
    await this.runRepoOp(`Checking out ${short}`, () => checkoutCommit(repo.path, hash), `Checked out ${short} (detached HEAD).`);
  }

  private async handleCreateBranch(hash: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    const short = hash.slice(0, 7);
    const name = await vscode.window.showInputBox({
      title: 'Create branch',
      prompt: `New branch at ${short} (it will be checked out)`,
      validateInput: (v) => (!v.trim() ? 'Branch name is required' : null),
    });
    if (!name) return;
    await this.runRepoOp(
      `Creating branch ${name.trim()}`,
      () => createBranchAt(repo.path, name.trim(), hash),
      `Created and checked out '${name.trim()}'.`,
    );
  }

  private async handleCherryPick(hash: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    const current = this.state.currentBranch;
    if (!current) {
      vscode.window.showErrorMessage('Detached HEAD — checkout a branch before cherry-picking.');
      return;
    }
    const short = hash.slice(0, 7);
    const confirm = await vscode.window.showWarningMessage(
      `Cherry-pick ${short} onto '${current}'?`,
      { modal: true },
      'Cherry-pick',
    );
    if (confirm !== 'Cherry-pick') return;
    await this.runRepoOp(`Cherry-picking ${short}`, () => cherryPick(repo.path, hash), `Cherry-picked ${short} onto '${current}'.`);
  }

  private async handleRevert(hash: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    const current = this.state.currentBranch;
    if (!current) {
      vscode.window.showErrorMessage('Detached HEAD — checkout a branch before reverting.');
      return;
    }
    const short = hash.slice(0, 7);
    const confirm = await vscode.window.showWarningMessage(
      `Revert ${short}? This adds a new commit on '${current}' that undoes its changes.`,
      { modal: true },
      'Revert',
    );
    if (confirm !== 'Revert') return;
    await this.runRepoOp(`Reverting ${short}`, () => revertCommit(repo.path, hash), `Reverted ${short}.`);
  }

  private async handleReset(hash: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    const current = this.state.currentBranch;
    if (!current) {
      vscode.window.showErrorMessage('Detached HEAD — cannot reset a branch.');
      return;
    }
    const short = hash.slice(0, 7);
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: 'Move HEAD only; keep index and working tree', mode: 'soft' as ResetMode },
        { label: 'Mixed', description: 'Reset index; keep working tree (default)', mode: 'mixed' as ResetMode },
        { label: 'Hard', description: 'Discard all index and working-tree changes', mode: 'hard' as ResetMode },
      ],
      { title: `Reset '${current}' to ${short}`, placeHolder: 'Choose reset mode' },
    );
    if (!pick) return;
    const warning = pick.mode === 'hard'
      ? `HARD reset '${current}' to ${short}? All uncommitted changes will be permanently lost.`
      : `${pick.label} reset '${current}' to ${short}?`;
    const action = `${pick.label} reset`;
    const confirm = await vscode.window.showWarningMessage(warning, { modal: true }, action);
    if (confirm !== action) return;
    await this.runRepoOp(`Resetting '${current}' to ${short}`, () => resetTo(repo.path, hash, pick.mode), `Reset '${current}' to ${short}.`);
  }

  private async handleBranchAction(action: BranchAction, branch: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    switch (action) {
      case 'checkout': return checkoutBranch(this.state, repo.path, branch);
      case 'pull': return pullBranch(this.state, repo.path, branch);
      case 'push': return pushBranch(this.state, repo.path, branch);
      case 'merge': return mergeBranch(this.state, repo.path, branch);
      case 'rename': return renameBranchAction(this.state, repo.path, branch);
      case 'delete': return deleteBranchAction(this.state, repo.path, branch);
    }
  }

  private async handleAddTag(hash: string) {
    const repo = this.state.selection.repo;
    if (!repo) return;
    const name = await vscode.window.showInputBox({
      title: 'Add tag',
      prompt: `Tag name for ${hash.slice(0, 7)}`,
      validateInput: (v) => (!v.trim() ? 'Tag name is required' : null),
    });
    if (!name) return;
    try {
      await createTag(repo.path, name.trim(), hash);
      vscode.window.setStatusBarMessage(`Created tag ${name.trim()}`, 3000);
      await this.state.refreshBranches();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Create tag failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleRenameTag(hash: string, tags: string[]) {
    const repo = this.state.selection.repo;
    if (!repo || tags.length === 0) return;
    const oldName = tags.length === 1 ? tags[0] : await vscode.window.showQuickPick(tags, { title: 'Rename which tag?' });
    if (!oldName) return;
    const newName = await vscode.window.showInputBox({
      title: `Rename tag ${oldName}`,
      value: oldName,
      validateInput: (v) => (!v.trim() ? 'Tag name is required' : v.trim() === oldName ? 'New name is the same' : null),
    });
    if (!newName) return;
    try {
      await renameTag(repo.path, oldName, newName.trim());
      vscode.window.setStatusBarMessage(`Renamed tag ${oldName} → ${newName.trim()}`, 3000);
      await this.state.refreshBranches();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Rename tag failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleDeleteTag(hash: string, tags: string[]) {
    const repo = this.state.selection.repo;
    if (!repo || tags.length === 0) return;
    const name = tags.length === 1 ? tags[0] : await vscode.window.showQuickPick(tags, { title: 'Delete which tag?' });
    if (!name) return;
    const confirm = await vscode.window.showWarningMessage(
      `Delete tag '${name}'?`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') return;
    try {
      await deleteTag(repo.path, name);
      vscode.window.setStatusBarMessage(`Deleted tag ${name}`, 3000);
      await this.state.refreshBranches();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Delete tag failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleMoveTag(hash: string) {
    const repo = this.state.selection.repo;
    if (!repo || this.state.tags.length === 0) {
      vscode.window.showInformationMessage('No tags exist in this repository.');
      return;
    }
    const name = await vscode.window.showQuickPick(this.state.tags, { title: 'Move which tag to this commit?' });
    if (!name) return;
    try {
      await moveTag(repo.path, name, hash);
      vscode.window.setStatusBarMessage(`Moved tag ${name} to ${hash.slice(0, 7)}`, 3000);
      await this.state.refreshBranches();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Move tag failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private dispose() {
    GraphPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function makeNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
