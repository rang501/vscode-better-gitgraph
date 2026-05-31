import * as vscode from 'vscode';
import { AppState, ALL_BRANCHES } from './state';
import { Repo, Branch } from './gitService';

export class RepoTreeProvider implements vscode.TreeDataProvider<RepoItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RepoItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private state: AppState) {
    state.onDidChangeRepos(() => this._onDidChangeTreeData.fire());
    state.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(el: RepoItem) { return el; }

  getChildren(): RepoItem[] {
    return this.state.repos.map((r) => new RepoItem(r, this.state.selection.repo?.path === r.path));
  }
}

export class RepoItem extends vscode.TreeItem {
  constructor(public readonly repo: Repo, selected: boolean) {
    super(repo.name, vscode.TreeItemCollapsibleState.None);
    this.description = selected ? '✓' : undefined;
    this.iconPath = new vscode.ThemeIcon(selected ? 'pass-filled' : 'repo');
    this.tooltip = repo.path;
    this.contextValue = 'repo';
    this.command = {
      command: 'betterGitGraph.selectRepo',
      title: 'Select repo',
      arguments: [repo],
    };
  }
}

interface BranchNode {
  name: string;
  fullPath: string;
  children: Map<string, BranchNode>;
  isLeaf: boolean;
}

export class BranchTreeProvider implements vscode.TreeDataProvider<BranchTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BranchTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private state: AppState, private extensionUri: vscode.Uri) {
    state.onDidChangeBranches(() => this._onDidChangeTreeData.fire());
    state.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(el: BranchTreeItem) { return el; }

  getChildren(element?: BranchTreeItem): BranchTreeItem[] {
    if (!element) return this.rootItems();
    if (element.node) return this.nodeChildren(element.node);
    return [];
  }

  private rootItems(): BranchTreeItem[] {
    const items: BranchTreeItem[] = [];
    items.push(BranchTreeItem.allBranches(this.state.selection.branch === ALL_BRANCHES));

    const filter = this.state.branchFilter.toLowerCase();
    const locals = this.state.branches.filter((b) => !b.isRemote);
    const remotes = this.state.branches.filter((b) => b.isRemote);

    const localRoot = this.buildTree(locals.map((b) => b.name));
    for (const child of this.sortChildren(localRoot)) {
      const filtered = filter ? this.filterNode(child, filter) : child;
      if (filtered) items.push(this.toItem(filtered));
    }

    if (remotes.length > 0) {
      const remoteRoot = this.buildTree(remotes.map((b) => b.name));
      const remotesNode: BranchNode = {
        name: 'Remote branches',
        fullPath: 'remotes',
        children: remoteRoot.children,
        isLeaf: false,
      };
      const filtered = filter ? this.filterNode(remotesNode, filter) : remotesNode;
      if (filtered) items.push(this.toItem(filtered));
    }

    return items;
  }

  private nodeChildren(node: BranchNode): BranchTreeItem[] {
    const filter = this.state.branchFilter.toLowerCase();
    const items: BranchTreeItem[] = [];
    for (const child of this.sortChildren(node)) {
      const filtered = filter ? this.filterNode(child, filter) : child;
      if (filtered) items.push(this.toItem(filtered));
    }
    return items;
  }

  private sortChildren(node: BranchNode): BranchNode[] {
    return [...node.children.values()].sort((a, b) => {
      const aFolder = a.children.size > 0 ? 1 : 0;
      const bFolder = b.children.size > 0 ? 1 : 0;
      return aFolder - bFolder;
    });
  }

  private buildTree(branches: string[]): BranchNode {
    const root: BranchNode = { name: '', fullPath: '', children: new Map(), isLeaf: false };
    for (const full of branches) {
      const parts = full.split('/');
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        let next = node.children.get(part);
        if (!next) {
          next = {
            name: part,
            fullPath: isLast ? full : parts.slice(0, i + 1).join('/'),
            children: new Map(),
            isLeaf: isLast,
          };
          node.children.set(part, next);
        } else if (isLast) {
          next.isLeaf = true;
          next.fullPath = full;
        }
        node = next;
      }
    }
    return root;
  }

  private filterNode(node: BranchNode, filter: string): BranchNode | null {
    if (node.isLeaf && node.children.size === 0) {
      return node.fullPath.toLowerCase().includes(filter) ? node : null;
    }
    const kept = new Map<string, BranchNode>();
    for (const [k, child] of node.children) {
      const f = this.filterNode(child, filter);
      if (f) kept.set(k, f);
    }
    if (kept.size === 0 && !node.name.toLowerCase().includes(filter)) return null;
    return { ...node, children: kept };
  }

  private toItem(node: BranchNode, forceExpand = false): BranchTreeItem {
    const selected = node.isLeaf && node.fullPath === this.state.selection.branch;
    const isHead = node.isLeaf && node.fullPath === this.state.currentBranch;
    const expand = forceExpand || (this.state.branchFilter.length > 0 && node.children.size > 0);
    return new BranchTreeItem(node, selected, expand, isHead, this.extensionUri);
  }
}

export class BranchTreeItem extends vscode.TreeItem {
  public readonly isRemote: boolean;
  public readonly isHead: boolean;

  constructor(
    public readonly node: BranchNode | undefined,
    selected: boolean,
    expand: boolean,
    isHead = false,
    extensionUri?: vscode.Uri,
  ) {
    const name = node?.name ?? '';
    super(
      isHead && name
        ? { label: name, highlights: [[0, name.length]] }
        : name,
      node && node.children.size > 0
        ? expand
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    this.isHead = isHead;
    this.isRemote = node?.fullPath.startsWith('remotes/') ?? false;
    if (!node) return;

    const isLeaf = node.isLeaf && node.children.size === 0;
    const isFolderAndLeaf = node.isLeaf && node.children.size > 0;

    if (isLeaf || isFolderAndLeaf) {
      const isNested = node.fullPath.includes('/');
      let icon: vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri };
      if (isHead) {
        icon = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      } else if (selected) {
        icon = new vscode.ThemeIcon('pass-filled');
      } else if (extensionUri) {
        const name = isNested ? 'branch-nested' : 'branch-leaf';
        icon = {
          light: vscode.Uri.joinPath(extensionUri, 'media', `${name}-light.svg`),
          dark: vscode.Uri.joinPath(extensionUri, 'media', `${name}-dark.svg`),
        };
      } else {
        icon = new vscode.ThemeIcon('git-branch');
      }
      this.iconPath = isFolderAndLeaf ? new vscode.ThemeIcon('folder') : icon;
      this.contextValue = this.isRemote ? 'remoteBranch' : 'branch';
      this.tooltip = isHead ? `${node.fullPath} (checked out)` : node.fullPath;
      this.description = isHead ? '● current' : undefined;
      this.command = {
        command: 'betterGitGraph.selectBranch',
        title: 'Select branch',
        arguments: [node.fullPath],
      };
    } else {
      const isRemotesRoot = node.fullPath === 'remotes';
      this.iconPath = new vscode.ThemeIcon(isRemotesRoot ? 'cloud' : 'folder');
      this.contextValue = isRemotesRoot ? 'remotesRoot' : 'branchFolder';
    }
  }

  static allBranches(selected: boolean): BranchTreeItem {
    const item = new BranchTreeItem(undefined, selected, false);
    item.label = 'All branches';
    item.iconPath = new vscode.ThemeIcon(selected ? 'pass-filled' : 'git-merge');
    item.contextValue = 'allBranches';
    item.description = selected ? '✓' : undefined;
    item.command = {
      command: 'betterGitGraph.selectBranch',
      title: 'Select all branches',
      arguments: [ALL_BRANCHES],
    };
    return item;
  }
}
