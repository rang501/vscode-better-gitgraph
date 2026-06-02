import * as vscode from 'vscode';
import { GraphPanel } from './panel';
import { AppState } from './state';
import { RepoTreeProvider, BranchTreeProvider, BranchTreeItem } from './treeProviders';
import { Repo, fetchAll } from './gitService';
import {
  checkoutBranch,
  pullBranch,
  pushBranch,
  mergeBranch,
  renameBranchAction,
  deleteBranchAction,
} from './branchActions';
import { GitContentProvider, SCHEME } from './contentProvider';

export async function activate(context: vscode.ExtensionContext) {
  const state = new AppState();
  const repoTree = new RepoTreeProvider(state);
  const branchTree = new BranchTreeProvider(state, context.extensionUri);

  const requireRepo = (): string | null => {
    const repo = state.selection.repo;
    if (!repo) {
      vscode.window.showErrorMessage('No repository selected.');
      return null;
    }
    return repo.path;
  };

  const branchNameFromArg = (arg: BranchTreeItem | undefined): string | null => {
    const node = arg?.node;
    if (!node || !node.isLeaf) {
      vscode.window.showErrorMessage('Select a branch first.');
      return null;
    }
    return node.fullPath;
  };

  const runGitOp = async (
    title: string,
    fn: () => Promise<string>,
    successMsg?: string,
  ) => {
    try {
      const out = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        fn,
      );
      if (successMsg) vscode.window.showInformationMessage(successMsg);
      const trimmed = out.trim();
      if (trimmed) {
        vscode.window.setStatusBarMessage(trimmed.split('\n')[0], 4000);
      }
      await state.refreshBranches();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`${title} failed: ${msg}`);
    }
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
    vscode.window.registerTreeDataProvider('betterGitGraph.repos', repoTree),
    vscode.window.registerTreeDataProvider('betterGitGraph.branches', branchTree),

    vscode.commands.registerCommand('betterGitGraph.open', () => {
      GraphPanel.show(context, state);
    }),

    vscode.commands.registerCommand('betterGitGraph.refreshRepos', async () => {
      await state.refreshRepos();
    }),

    vscode.commands.registerCommand('betterGitGraph.refreshBranches', async () => {
      await state.refreshBranches();
    }),

    vscode.commands.registerCommand('betterGitGraph.selectRepo', async (repo: Repo) => {
      await state.selectRepo(repo);
      GraphPanel.show(context, state);
    }),

    vscode.commands.registerCommand('betterGitGraph.selectBranch', (branch: string) => {
      state.selectBranch(branch);
      GraphPanel.show(context, state);
    }),

    vscode.commands.registerCommand('betterGitGraph.filterBranches', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Filter branches',
        placeHolder: 'e.g. feature, fix/auth',
        value: state.branchFilter,
      });
      if (value !== undefined) state.setBranchFilter(value);
    }),

    vscode.commands.registerCommand('betterGitGraph.clearBranchFilter', () => {
      state.setBranchFilter('');
    }),

    vscode.commands.registerCommand('betterGitGraph.copyBranch', async (item: BranchTreeItem) => {
      const name = item?.node?.fullPath;
      if (name) {
        await vscode.env.clipboard.writeText(name);
        vscode.window.setStatusBarMessage(`Copied: ${name}`, 2000);
      }
    }),

    vscode.commands.registerCommand('betterGitGraph.checkoutBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const name = branchNameFromArg(item);
      if (name) await checkoutBranch(state, repoPath, name);
    }),

    vscode.commands.registerCommand('betterGitGraph.pullBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const name = branchNameFromArg(item);
      if (name) await pullBranch(state, repoPath, name);
    }),

    vscode.commands.registerCommand('betterGitGraph.pushBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const name = branchNameFromArg(item);
      if (name) await pushBranch(state, repoPath, name);
    }),

    vscode.commands.registerCommand('betterGitGraph.mergeBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const name = branchNameFromArg(item);
      if (name) await mergeBranch(state, repoPath, name);
    }),

    vscode.commands.registerCommand('betterGitGraph.renameBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const name = branchNameFromArg(item);
      if (name) await renameBranchAction(state, repoPath, name);
    }),

    vscode.commands.registerCommand('betterGitGraph.deleteBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const name = branchNameFromArg(item);
      if (name) await deleteBranchAction(state, repoPath, name);
    }),

    vscode.commands.registerCommand('betterGitGraph.fetchAll', async () => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      await runGitOp('Fetching all remotes', () => fetchAll(repoPath), 'Fetch complete.');
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => state.refreshRepos()),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('betterGitGraph.autoRefresh')) state.refreshWatcher();
    }),

    { dispose: () => state.dispose() }
  );

  await state.refreshRepos();
}

export function deactivate() {}
