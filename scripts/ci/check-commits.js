#!/usr/bin/env node
// Enforces the AGENTS.md git workflow on a commit range (and, through commit-msg.js, on
// each message as it's written):
//   • subjects follow Conventional Commits and are ≤ 72 characters
//   • no agent attribution (rule 8): no AI/bot Co-Authored-By trailers or "Generated with" footers
// Also checks the PR description when PR_BODY is set (as in CI).
//
// Usage: node check-commits.js [range]      (default: origin/main..HEAD)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'chore', 'ci', 'build', 'perf', 'style', 'revert'];
const CONVENTIONAL = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: \\S.*$`);
const EXEMPT = [/^Merge (pull request|branch|remote-tracking branch) /, /^Revert "/];
// A footer line starts with "Generated with/by", optionally after whitespace, emoji or
// Markdown markers. Quoting the phrase inside a sentence is not attribution.
const FOOTER = /^[\s\p{Extended_Pictographic}\uFE0F*_>-]*generated (with|by)\b/iu;
const AGENT = /(claude|anthropic|copilot|openai|chatgpt|codex|cursor|gemini|devin|\[bot\])/i;

export function checkSubject(subject) {
  if (EXEMPT.some((re) => re.test(subject))) return null;
  if (!CONVENTIONAL.test(subject)) return `not a Conventional Commit subject (types: ${TYPES.join(', ')})`;
  if (subject.length > 72) return `subject is ${subject.length} chars (max 72)`;
  return null;
}

export function findAgentAttribution(text) {
  const found = [];
  for (const line of text.split('\n')) {
    if (/^\s*co-authored-by:/i.test(line) && AGENT.test(line)) found.push(line.trim());
    if (FOOTER.test(line) && AGENT.test(line)) found.push(line.trim());
  }
  return found;
}

// A message as git hands it to the commit-msg hook: comment lines and everything below
// the scissors line (from `commit -v`) aren't part of the commit.
export function checkMessage(text) {
  const lines = [];
  for (const line of text.split('\n')) {
    if (/^# -+ >8 -+$/.test(line)) break;
    if (!line.startsWith('#')) lines.push(line);
  }
  const subject = lines.find((line) => line.trim() !== '');
  if (subject === undefined) return ['the commit message is empty'];
  const problems = [];
  const subjectProblem = checkSubject(subject);
  if (subjectProblem) problems.push(`"${subject}": ${subjectProblem}`);
  for (const line of findAgentAttribution(lines.join('\n'))) problems.push(`agent attribution not allowed (AGENTS.md rule 8): ${line}`);
  return problems;
}

export function readCommits(range) {
  const out = execFileSync('git', ['log', '--format=%H%x1f%s%x1f%B%x1e', range], { encoding: 'utf8' });
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body] = r.split('\x1f');
      return { sha, subject, body };
    });
}

export function checkCommits(commits) {
  const problems = [];
  for (const c of commits) {
    const subjectProblem = checkSubject(c.subject);
    if (subjectProblem) problems.push(`${c.sha.slice(0, 7)} "${c.subject}": ${subjectProblem}`);
    for (const line of findAgentAttribution(c.body)) problems.push(`${c.sha.slice(0, 7)}: agent attribution not allowed (AGENTS.md rule 8): ${line}`);
  }
  return problems;
}

function main() {
  const range = process.argv[2] ?? 'origin/main..HEAD';
  const commits = readCommits(range);
  const problems = checkCommits(commits);
  if (process.env.PR_BODY) {
    for (const line of findAgentAttribution(process.env.PR_BODY)) problems.push(`PR description: agent attribution not allowed (AGENTS.md rule 8): ${line}`);
  }
  if (problems.length === 0) {
    console.log(`✓ commits: ${commits.length} commit(s) in ${range} follow the git workflow`);
    return 0;
  }
  console.error(`✗ commits: ${problems.length} problem(s) in ${range}:`);
  problems.forEach((p) => console.error(`  ${p}`));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
