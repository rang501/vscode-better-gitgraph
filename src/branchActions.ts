import * as vscode from 'vscode';
import { AppState, ALL_BRANCHES } from './state';
import { checkout, pull, push, merge, renameBranch, deleteBranch, deleteRemoteBranch } from './gitService';

/**
 * Shared branch operations used by both the Branches sidebar commands and the
 * commit-log context menu, so the two entry points behave identically.
 */

async function runGitOp(state: AppState, title: string, fn: () => Promise<string>, successMsg?: string) {
  try {
    const out = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      fn,
    );
    if (successMsg) vscode.window.showInformationMessage(successMsg);
    const trimmed = out.trim();
    if (trimmed) vscode.window.setStatusBarMessage(trimmed.split('\n')[0], 4000);
    await state.refreshBranches();
  } catch (e: unknown) {
    vscode.window.showErrorMessage(`${title} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function confirm(message: string, action: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, action);
  return choice === action;
}

/**
 * The branch tree item's isRemote flag is unreliable for nested remote leaves;
 * resolve against the loaded branch list, which is the source of truth.
 */
export function isRemoteBranch(state: AppState, name: string): boolean {
  return state.branches.find((b) => b.name === name)?.isRemote ?? false;
}

export async function checkoutBranch(state: AppState, repoPath: string, name: string) {
  if (!(await confirm(`Checkout '${name}'? Uncommitted changes may block this.`, 'Checkout'))) return;
  await runGitOp(state, `Checking out ${name}`, () => checkout(repoPath, name, isRemoteBranch(state, name)));
  // If a non-"all" branch was selected as the filter, follow the new HEAD.
  if (state.selection.branch !== ALL_BRANCHES && state.currentBranch) {
    state.selectBranch(state.currentBranch);
  }
}

export async function pullBranch(state: AppState, repoPath: string, name: string) {
  if (name !== state.currentBranch) {
    vscode.window.showErrorMessage(
      `Pull only works on the current branch. '${name}' is not currently checked out.`,
    );
    return;
  }
  await runGitOp(state, `Pulling ${name}`, () => pull(repoPath), `Pulled '${name}'.`);
}

export async function pushBranch(state: AppState, repoPath: string, name: string) {
  if (!(await confirm(`Push '${name}' to origin?`, 'Push'))) return;
  await runGitOp(state, `Pushing ${name}`, () => push(repoPath, name), `Pushed '${name}' to origin.`);
}

export async function mergeBranch(state: AppState, repoPath: string, name: string) {
  const current = state.currentBranch;
  if (!current) {
    vscode.window.showErrorMessage('Detached HEAD — cannot merge.');
    return;
  }
  if (name === current) {
    vscode.window.showErrorMessage('Cannot merge a branch into itself.');
    return;
  }
  if (!(await confirm(`Merge '${name}' into '${current}'?`, 'Merge'))) return;
  await runGitOp(
    state,
    `Merging ${name} into ${current}`,
    () => merge(repoPath, name),
    `Merged '${name}' into '${current}'.`,
  );
}

export async function renameBranchAction(state: AppState, repoPath: string, name: string) {
  if (isRemoteBranch(state, name)) {
    vscode.window.showErrorMessage('Renaming remote branches is not supported.');
    return;
  }
  const newName = await vscode.window.showInputBox({
    title: `Rename branch '${name}'`,
    value: name,
    validateInput: (v) =>
      !v.trim() ? 'Branch name is required' : v.trim() === name ? 'New name is the same' : null,
  });
  if (!newName) return;
  const wasSelected = state.selection.branch === name;
  await runGitOp(
    state,
    `Renaming ${name} → ${newName.trim()}`,
    () => renameBranch(repoPath, name, newName.trim()),
    `Renamed '${name}' → '${newName.trim()}'.`,
  );
  if (wasSelected) state.selectBranch(newName.trim());
}

export async function deleteBranchAction(state: AppState, repoPath: string, name: string) {
  if (isRemoteBranch(state, name)) {
    const slash = name.indexOf('/');
    const remote = slash >= 0 ? name.slice(0, slash) : 'origin';
    const branch = slash >= 0 ? name.slice(slash + 1) : name;
    if (!(await confirm(`Delete remote branch '${name}'? This removes it on '${remote}' for everyone.`, 'Delete'))) return;
    await runGitOp(
      state,
      `Deleting remote branch ${name}`,
      () => deleteRemoteBranch(repoPath, remote, branch),
      `Deleted remote branch '${name}'.`,
    );
    return;
  }

  if (name === state.currentBranch) {
    vscode.window.showErrorMessage(`Cannot delete '${name}' — it is the current branch.`);
    return;
  }
  if (!(await confirm(`Delete branch '${name}'?`, 'Delete'))) return;

  const doDelete = (force: boolean) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Deleting ${name}`, cancellable: false },
      () => deleteBranch(repoPath, name, force),
    );
  try {
    await doDelete(false);
    vscode.window.setStatusBarMessage(`Deleted '${name}'.`, 4000);
    await state.refreshBranches();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not fully merged/i.test(msg)) {
      vscode.window.showErrorMessage(`Delete branch failed: ${msg}`);
      return;
    }
    if (!(await confirm(`'${name}' is not fully merged. Force delete? Unmerged commits will be lost.`, 'Force delete'))) return;
    try {
      await doDelete(true);
      vscode.window.setStatusBarMessage(`Force-deleted '${name}'.`, 4000);
      await state.refreshBranches();
    } catch (e2: unknown) {
      vscode.window.showErrorMessage(`Delete branch failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
}
