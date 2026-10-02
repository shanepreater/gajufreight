#!/usr/bin/env node
// Checks every relative link in the repo's Markdown: the target must exist, and a
// #fragment pointing at a Markdown file must match one of its headings (GitHub
// anchor rules). External (http/mailto) links are skipped to keep CI offline and fast.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listRepoFiles } from './lib/git-files.js';

// Removes fenced code blocks and inline code so example links are not checked.
export function stripCode(markdown) {
  return markdown.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

// GitHub heading anchor: lowercase, drop punctuation, spaces become hyphens.
export function slugify(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/[*_`]/g, (c) => (c === '_' ? '_' : ''))
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

export function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  for (const line of stripCode(markdown).split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slugify(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

export function extractLinks(markdown) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of stripCode(markdown).matchAll(pattern)) links.push(m[1]);
  return links;
}

const isExternal = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href);

// Returns a list of { file, href, problem } for one Markdown file.
export function checkFile(file, { root = process.cwd(), read = (p) => readFileSync(p, 'utf8') } = {}) {
  const problems = [];
  const source = read(join(root, file));
  for (const href of extractLinks(source)) {
    if (isExternal(href)) continue;
    const [rawPath, fragment] = href.split('#');
    const path = decodeURIComponent(rawPath);
    const target = path === '' ? file : normalize(join(dirname(file), path));
    const abs = join(root, target);
    const fromRoot = relative(root, abs);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      problems.push({ file, href, problem: 'target is outside the repository' });
      continue;
    }
    if (!existsSync(abs)) {
      problems.push({ file, href, problem: 'target does not exist' });
      continue;
    }
    if (fragment && target.endsWith('.md') && statSync(abs).isFile()) {
      if (!headingAnchors(read(abs)).has(decodeURIComponent(fragment))) {
        problems.push({ file, href, problem: `no heading for #${fragment}` });
      }
    }
  }
  return problems;
}

function main() {
  const files = listRepoFiles().filter((f) => f.endsWith('.md'));
  const problems = files.flatMap((f) => checkFile(f));
  if (problems.length === 0) {
    console.log(`✓ doc links: ${files.length} Markdown files, all relative links and anchors resolve`);
    return 0;
  }
  console.error(`✗ doc links: ${problems.length} broken link(s):`);
  problems.forEach((p) => console.error(`  ${p.file}: (${p.href}) ${p.problem}`));
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
