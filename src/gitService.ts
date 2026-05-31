import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const pexec = promisify(exec);

export interface Repo {
  name: string;
  path: string;
}

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: string[];
  parents: string[];
}

export interface LogFilters {
  branch?: string;
  allBranches?: boolean;
  author?: string;
  since?: string;
  until?: string;
  limit?: number;
  tag?: string;
  subject?: string;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

async function run(cwd: string, args: string[]): Promise<string> {
  const cmd = ['git', ...args.map(quote)].join(' ');
  const { stdout } = await pexec(cmd, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function quote(arg: string): string {
  if (/^[A-Za-z0-9_\-./=:,@]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(path.join(dir, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

interface GitExtensionApi {
  repositories: { rootUri: vscode.Uri }[];
}

async function discoverViaGitApi(): Promise<Repo[]> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitExtensionApi }>('vscode.git');
  if (!ext) return [];
  if (!ext.isActive) await ext.activate();
  const api = ext.exports.getAPI(1);
  return api.repositories.map((r) => {
    const p = r.rootUri.fsPath;
    return { name: path.basename(p), path: p };
  });
}

async function discoverViaScan(maxDepth = 3): Promise<Repo[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const repos: Repo[] = [];
  const seen = new Set<string>();
  const skip = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'target', '.venv', 'venv']);

  const walk = async (dir: string, depth: number, label: string) => {
    if (seen.has(dir)) return;
    if (await isGitRepo(dir)) {
      seen.add(dir);
      repos.push({ name: label, path: dir });
      return; // don't descend into a repo
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || skip.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1, `${label}/${e.name}`);
    }
  };

  for (const f of folders) {
    await walk(f.uri.fsPath, 0, f.name);
  }
  return repos;
}

export async function discoverRepos(): Promise<Repo[]> {
  const fromApi = await discoverViaGitApi();
  if (fromApi.length > 0) return fromApi;
  return discoverViaScan();
}

export interface Branch {
  name: string;
  isRemote: boolean;
}

export async function listBranches(repo: string): Promise<Branch[]> {
  const out = await run(repo, [
    'for-each-ref',
    '--format=%(refname)\x1f%(refname:short)',
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes',
  ]);
  const branches: Branch[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [fullref, short] = trimmed.split(FIELD);
    if (!short || short.endsWith('/HEAD')) continue;
    branches.push({ name: short, isRemote: fullref.startsWith('refs/remotes/') });
  }
  return branches;
}

export async function listAuthors(repo: string): Promise<string[]> {
  const out = await run(repo, ['log', '--all', '--format=%aN', '--max-count=2000']);
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    const v = line.trim();
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export async function currentBranch(repo: string): Promise<string | null> {
  try {
    const out = await run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = out.trim();
    return name === 'HEAD' ? null : name;
  } catch {
    return null;
  }
}

export async function checkout(repo: string, branch: string, isRemote: boolean): Promise<string> {
  if (isRemote) {
    const slash = branch.indexOf('/');
    const local = slash >= 0 ? branch.slice(slash + 1) : branch;
    try {
      const out = await run(repo, ['switch', local]);
      return out;
    } catch {
      return await run(repo, ['switch', '-c', local, '--track', branch]);
    }
  }
  return await run(repo, ['switch', branch]);
}

export async function pull(repo: string): Promise<string> {
  return await run(repo, ['pull', '--ff-only']);
}

export async function push(repo: string, branch: string): Promise<string> {
  return await run(repo, ['push', '-u', 'origin', branch]);
}

export async function merge(repo: string, branch: string): Promise<string> {
  return await run(repo, ['merge', '--no-edit', branch]);
}

export async function renameBranch(repo: string, oldName: string, newName: string): Promise<string> {
  return await run(repo, ['branch', '-m', oldName, newName]);
}

export async function deleteBranch(repo: string, name: string, force: boolean): Promise<string> {
  return await run(repo, ['branch', force ? '-D' : '-d', name]);
}

export async function deleteRemoteBranch(repo: string, remote: string, branch: string): Promise<string> {
  return await run(repo, ['push', remote, '--delete', branch]);
}

export async function fetchAll(repo: string): Promise<string> {
  return await run(repo, ['fetch', '--all', '--prune']);
}

export async function checkoutCommit(repo: string, sha: string): Promise<string> {
  return await run(repo, ['checkout', sha]);
}

export async function createBranchAt(repo: string, name: string, sha: string): Promise<string> {
  return await run(repo, ['switch', '-c', name, sha]);
}

export async function cherryPick(repo: string, sha: string): Promise<string> {
  return await run(repo, ['cherry-pick', sha]);
}

export async function revertCommit(repo: string, sha: string): Promise<string> {
  return await run(repo, ['revert', '--no-edit', sha]);
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

export async function resetTo(repo: string, sha: string, mode: ResetMode): Promise<string> {
  return await run(repo, ['reset', `--${mode}`, sha]);
}

export async function listTags(repo: string): Promise<string[]> {
  try {
    const out = await run(repo, ['tag', '--list', '--sort=-creatordate']);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function createTag(repo: string, name: string, sha: string): Promise<string> {
  return await run(repo, ['tag', name, sha]);
}

export async function deleteTag(repo: string, name: string): Promise<string> {
  return await run(repo, ['tag', '-d', name]);
}

export async function renameTag(repo: string, oldName: string, newName: string): Promise<string> {
  await run(repo, ['tag', newName, `${oldName}^{}`]);
  return await run(repo, ['tag', '-d', oldName]);
}

export async function moveTag(repo: string, name: string, sha: string): Promise<string> {
  return await run(repo, ['tag', '-f', name, sha]);
}

export interface CommitDetails {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  parents: string[];
  refs: string[];
}

export async function getCommitDetails(repo: string, sha: string): Promise<CommitDetails> {
  const format = ['%H', '%h', '%aN', '%aE', '%aI', '%s', '%P', '%D', '%b'].join(FIELD);
  const out = await run(repo, ['show', '-s', `--format=${format}`, sha]);
  const [hash, shortHash, author, email, date, subject, parents, refs, ...bodyParts] = out.split(FIELD);
  // %b may itself contain newlines; the final field is everything after the last delimiter
  const body = bodyParts.join(FIELD).replace(/\n$/, '');
  return {
    hash,
    shortHash,
    author,
    email,
    date,
    subject,
    body,
    parents: parents ? parents.trim().split(/\s+/).filter(Boolean) : [],
    refs: refs ? refs.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}

export interface CommitFile {
  status: string; // M, A, D, R<score>, C<score>, T
  path: string;
  oldPath?: string;
}

export async function getCommitFiles(repo: string, sha: string): Promise<CommitFile[]> {
  const out = await run(repo, ['show', '--name-status', '--format=', '-M', sha]);
  const files: CommitFile[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const status = parts[0];
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status, oldPath: parts[1], path: parts[2] });
    } else {
      files.push({ status, path: parts[1] });
    }
  }
  return files;
}

export async function getCommitFileDiff(
  repo: string,
  sha: string,
  filePath: string,
  oldPath?: string
): Promise<string> {
  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  return await run(repo, ['show', '-M', '--format=', '--patch', sha, '--', ...paths]);
}

export async function showAtRef(repo: string, ref: string, filePath: string): Promise<string> {
  try {
    return await run(repo, ['show', `${ref}:${filePath}`]);
  } catch {
    return '';
  }
}

export async function getLog(repo: string, filters: LogFilters): Promise<Commit[]> {
  const format = ['%H', '%h', '%aN', '%aE', '%aI', '%s', '%D', '%P'].join(FIELD) + RECORD;
  const args = [
    'log',
    `--format=${format}`,
    `--max-count=${filters.limit ?? 500}`,
    '--date-order',
  ];

  if (filters.allBranches && !filters.tag) args.push('--all');
  if (filters.author) args.push(`--author=${filters.author}`);
  if (filters.since) args.push(`--since=${filters.since}`);
  if (filters.until) args.push(`--until=${filters.until}`);
  if (filters.subject) {
    args.push('-i', '-F', `--grep=${filters.subject}`);
  }
  if (filters.tag) {
    args.push(`refs/tags/${filters.tag}`);
  } else if (!filters.allBranches && filters.branch) {
    args.push(filters.branch);
  }

  const out = await run(repo, args);
  const records = out.split(RECORD).map((r) => r.replace(/^\n/, '')).filter((r) => r.length > 0);
  return records.map((r) => {
    const [hash, shortHash, author, email, date, subject, refs, parents] = r.split(FIELD);
    return {
      hash,
      shortHash,
      author,
      email,
      date,
      subject,
      refs: refs ? refs.split(',').map((s) => s.trim()).filter(Boolean) : [],
      parents: parents ? parents.trim().split(/\s+/).filter(Boolean) : [],
    };
  });
}
