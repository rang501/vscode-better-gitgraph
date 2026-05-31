import * as vscode from 'vscode';
import { GraphPanel } from './panel';
import { AppState, ALL_BRANCHES } from './state';
import { RepoTreeProvider, BranchTreeProvider, BranchTreeItem } from './treeProviders';
import { Repo, checkout, pull, push, merge, fetchAll, renameBranch, deleteBranch, deleteRemoteBranch } from './gitService';
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

  // The tree item's isRemote flag is unreliable for nested remote leaves;
  // resolve against the loaded branch list, which is the source of truth.
  const isRemoteBranch = (name: string): boolean =>
    state.branches.find((b) => b.name === name)?.isRemote ?? false;

  const branchFromArg = (arg: BranchTreeItem | undefined): { name: string; isRemote: boolean } | null => {
    const node = arg?.node;
    if (!node || !node.isLeaf) {
      vscode.window.showErrorMessage('Select a branch first.');
      return null;
    }
    return { name: node.fullPath, isRemote: arg!.isRemote };
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

  const confirm = async (message: string, action: string): Promise<boolean> => {
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      action,
    );
    return choice === action;
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
      const b = branchFromArg(item);
      if (!b) return;
      if (!(await confirm(`Checkout '${b.name}'? Uncommitted changes may block this.`, 'Checkout'))) return;
      await runGitOp(`Checking out ${b.name}`, () => checkout(repoPath, b.name, b.isRemote));
      if (state.selection.branch !== ALL_BRANCHES) {
        // if user had a non-current branch selected as filter, update to new HEAD
        if (state.currentBranch) state.selectBranch(state.currentBranch);
      }
    }),

    vscode.commands.registerCommand('betterGitGraph.pullBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const b = branchFromArg(item);
      if (!b) return;
      if (b.name !== state.currentBranch) {
        vscode.window.showErrorMessage(
          `Pull only works on the current branch. '${b.name}' is not currently checked out.`
        );
        return;
      }
      await runGitOp(`Pulling ${b.name}`, () => pull(repoPath), `Pulled '${b.name}'.`);
    }),

    vscode.commands.registerCommand('betterGitGraph.pushBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const b = branchFromArg(item);
      if (!b) return;
      if (!(await confirm(`Push '${b.name}' to origin?`, 'Push'))) return;
      await runGitOp(`Pushing ${b.name}`, () => push(repoPath, b.name), `Pushed '${b.name}' to origin.`);
    }),

    vscode.commands.registerCommand('betterGitGraph.mergeBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const b = branchFromArg(item);
      if (!b) return;
      const current = state.currentBranch;
      if (!current) {
        vscode.window.showErrorMessage('Detached HEAD — cannot merge.');
        return;
      }
      if (b.name === current) {
        vscode.window.showErrorMessage('Cannot merge a branch into itself.');
        return;
      }
      if (!(await confirm(`Merge '${b.name}' into '${current}'?`, 'Merge'))) return;
      await runGitOp(`Merging ${b.name} into ${current}`, () => merge(repoPath, b.name), `Merged '${b.name}' into '${current}'.`);
    }),

    vscode.commands.registerCommand('betterGitGraph.renameBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const b = branchFromArg(item);
      if (!b) return;
      if (isRemoteBranch(b.name)) {
        vscode.window.showErrorMessage('Renaming remote branches is not supported.');
        return;
      }
      const newName = await vscode.window.showInputBox({
        title: `Rename branch '${b.name}'`,
        value: b.name,
        validateInput: (v) =>
          !v.trim() ? 'Branch name is required' : v.trim() === b.name ? 'New name is the same' : null,
      });
      if (!newName) return;
      const wasSelected = state.selection.branch === b.name;
      await runGitOp(
        `Renaming ${b.name} → ${newName.trim()}`,
        () => renameBranch(repoPath, b.name, newName.trim()),
        `Renamed '${b.name}' → '${newName.trim()}'.`,
      );
      if (wasSelected) state.selectBranch(newName.trim());
    }),

    vscode.commands.registerCommand('betterGitGraph.deleteBranch', async (item: BranchTreeItem) => {
      const repoPath = requireRepo();
      if (!repoPath) return;
      const b = branchFromArg(item);
      if (!b) return;

      if (isRemoteBranch(b.name)) {
        const slash = b.name.indexOf('/');
        const remote = slash >= 0 ? b.name.slice(0, slash) : 'origin';
        const branch = slash >= 0 ? b.name.slice(slash + 1) : b.name;
        if (!(await confirm(`Delete remote branch '${b.name}'? This removes it on '${remote}' for everyone.`, 'Delete'))) return;
        await runGitOp(
          `Deleting remote branch ${b.name}`,
          () => deleteRemoteBranch(repoPath, remote, branch),
          `Deleted remote branch '${b.name}'.`,
        );
        return;
      }

      if (b.name === state.currentBranch) {
        vscode.window.showErrorMessage(`Cannot delete '${b.name}' — it is the current branch.`);
        return;
      }
      if (!(await confirm(`Delete branch '${b.name}'?`, 'Delete'))) return;

      const doDelete = (force: boolean) =>
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Deleting ${b.name}`, cancellable: false },
          () => deleteBranch(repoPath, b.name, force),
        );
      try {
        await doDelete(false);
        vscode.window.setStatusBarMessage(`Deleted '${b.name}'.`, 4000);
        await state.refreshBranches();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/not fully merged/i.test(msg)) {
          vscode.window.showErrorMessage(`Delete branch failed: ${msg}`);
          return;
        }
        if (!(await confirm(`'${b.name}' is not fully merged. Force delete? Unmerged commits will be lost.`, 'Force delete'))) return;
        try {
          await doDelete(true);
          vscode.window.setStatusBarMessage(`Force-deleted '${b.name}'.`, 4000);
          await state.refreshBranches();
        } catch (e2: unknown) {
          vscode.window.showErrorMessage(`Delete branch failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
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
