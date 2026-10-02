import { execFileSync } from 'node:child_process';

// Tracked files plus new untracked (not ignored) files, so local runs catch
// problems before they are committed.
export function listRepoFiles(cwd = process.cwd()) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}
