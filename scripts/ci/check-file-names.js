#!/usr/bin/env node
// Enforces AGENTS.md: every file and directory name is kebab-case, except names
// fixed by convention or required by tools. Python is the one language exception:
// PEP 8 module and package names are snake_case (hyphens cannot be imported), so
// .py files and directories that directly contain .py files use snake_case.
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listRepoFiles } from './lib/git-files.js';

export const ALLOWED_NAMES = new Set([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'SKILL.md',
  'LICENSE',
  'CODEOWNERS',
  'Dockerfile',
  'pull_request_template.md',
]);

// Lowercase words joined by hyphens, with optional dot-separated extensions
// (e.g. "sim-chain.test.js"), and an optional leading dot (".github").
const KEBAB = /^\.?[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

// PEP 8 snake_case, allowing dunder names such as __init__.
const SNAKE = /^(__)?[a-z][a-z0-9]*(_[a-z0-9]+)*(__)?$/;
const PYTHON_FILE = /\.pyi?$/;

export const isValidSegment = (name) => ALLOWED_NAMES.has(name) || KEBAB.test(name);
export const isPythonName = (name) => SNAKE.test(name.replace(PYTHON_FILE, ''));

export function findInvalidPaths(paths) {
  const pythonDirs = new Set(paths.filter((p) => PYTHON_FILE.test(p)).map((p) => dirname(p)));
  return paths.filter((path) => {
    const segments = path.split('/');
    return !segments.every((segment, i) => {
      const isLast = i === segments.length - 1;
      if (isLast && PYTHON_FILE.test(segment)) return isPythonName(segment);
      if (isValidSegment(segment)) return true;
      const dir = segments.slice(0, i + 1).join('/');
      return !isLast && pythonDirs.has(dir) && isPythonName(segment);
    });
  });
}

function main() {
  const bad = findInvalidPaths(listRepoFiles());
  if (bad.length === 0) {
    console.log('✓ file names: all kebab-case');
    return 0;
  }
  console.error(`✗ file names: ${bad.length} path(s) are not kebab-case (see AGENTS.md → Conventions):`);
  bad.forEach((p) => console.error(`  ${p}`));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
