import * as vscode from 'vscode';
import { showAtRef } from './gitService';

export const SCHEME = 'bettergit';

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = parseQuery(uri.query);
    const repo = params.get('repo');
    const ref = params.get('ref');
    const filePath = params.get('path');
    if (!repo || !ref || !filePath) return '';
    if (ref === 'empty') return '';
    return await showAtRef(repo, ref, filePath);
  }
}

function parseQuery(query: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    result.set(decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1)));
  }
  return result;
}

export function makeUri(repo: string, ref: string, filePath: string): vscode.Uri {
  const query = `repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(filePath)}`;
  // path component carries the file's display name so the diff tab is named correctly
  return vscode.Uri.parse(`${SCHEME}:/${ref.slice(0, 7)}/${filePath}?${query}`);
}
