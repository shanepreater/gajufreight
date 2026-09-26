#!/usr/bin/env node
// Enforces AGENTS.md: every file and directory name is kebab-case, except names
// fixed by convention or required by tools.
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

export const isValidSegment = (name) => ALLOWED_NAMES.has(name) || KEBAB.test(name);

export function findInvalidPaths(paths) {
  return paths.filter((p) => !p.split('/').every(isValidSegment));
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
