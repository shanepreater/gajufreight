#!/usr/bin/env node
// The commit-msg hook: applies CI's commit rules to the message being written, so a bad
// subject is fixed before it's committed rather than by rewriting a pushed branch.
//
// Usage: node commit-msg.js <message-file>   (git passes .git/COMMIT_EDITMSG)
// Install once per clone: npm run hooks --prefix scripts/ci
import { readFileSync } from 'node:fs';
import { checkMessage } from './check-commits.js';

const problems = checkMessage(readFileSync(process.argv[2], 'utf8'));
if (problems.length > 0) {
  console.error('✗ commit message (AGENTS.md git workflow):');
  problems.forEach((p) => console.error(`  ${p}`));
  console.error('Git keeps your message in COMMIT_EDITMSG in the repo\'s git directory; fix it and commit again.');
  process.exitCode = 1;
}
