#!/usr/bin/env node
// Loads every wireframe in a real browser at phone and desktop widths and checks the
// ux-designer basics: no horizontal page scroll, internal links and anchors resolve,
// controls and images are labelled, and touch targets are at least 44 px.
// Local only (no CI minutes). Screenshots go to ./screenshots (git-ignored).
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = resolve(here, '../../docs/wireframes');
const shotsDir = join(here, 'screenshots');
const WIDTHS = [390, 1280];
const MIN_TARGET = 44;

// Runs inside the page: returns a list of problems found on it.
function auditPage(minTarget) {
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 1) problems.push(`page scrolls horizontally (${doc.scrollWidth}px > ${window.innerWidth}px)`);

  const nameOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim();
  for (const el of document.querySelectorAll('img:not([alt])')) problems.push(`<img> without alt: ${el.outerHTML.slice(0, 60)}`);
  for (const el of document.querySelectorAll('[role="img"]')) {
    if (!el.getAttribute('aria-label')) problems.push(`role=img without aria-label: ${el.outerHTML.slice(0, 60)}`);
  }
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const labelled = el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
    if (!labelled) problems.push(`unlabelled ${el.tagName.toLowerCase()} #${el.id || '?'}`);
  }
  for (const el of document.querySelectorAll('button, a.btn')) {
    if (!nameOf(el)) problems.push(`control without an accessible name: ${el.outerHTML.slice(0, 60)}`);
  }
  // A labelled radio or checkbox's target is its label, so measure that instead.
  const target = (el) => (el.matches('input[type="radio"], input[type="checkbox"]') ? el.closest('label') ?? el : el);
  for (const el of document.querySelectorAll('.btn, input:not([type="range"]), select')) {
    const box = target(el).getBoundingClientRect();
    if (box.width && box.height < minTarget) problems.push(`touch target ${Math.round(box.height)}px < ${minTarget}px: ${nameOf(el).slice(0, 30) || el.id}`);
  }
  const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
  return { problems, links, ids: [...document.querySelectorAll('[id]')].map((e) => e.id) };
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });
  const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.html')).sort();
  const browser = await chromium.launch();
  const failures = [];
  const idsByPage = new Map();
  const linksByPage = new Map();

  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    for (const file of pages) {
      await page.goto(pathToFileURL(join(pagesDir, file)).href);
      const { problems, links, ids } = await page.evaluate(auditPage, MIN_TARGET);
      problems.forEach((p) => failures.push(`${file} @${width}px: ${p}`));
      idsByPage.set(file, new Set(ids));
      linksByPage.set(file, links);
      await page.screenshot({ path: join(shotsDir, `${file.replace('.html', '')}-${width}.png`), fullPage: true });
    }
    await page.close();
  }
  await browser.close();

  // Internal links and #anchors must resolve to a wireframe file and element.
  for (const [file, links] of linksByPage) {
    for (const href of links) {
      if (/^[a-z]+:/i.test(href)) continue; // external
      const [path, anchor] = href.split('#');
      const target = path || file;
      if (!existsSync(join(pagesDir, target))) failures.push(`${file}: link to missing ${href}`);
      else if (anchor && !idsByPage.get(target)?.has(anchor)) failures.push(`${file}: no #${anchor} in ${target}`);
    }
  }

  if (failures.length) {
    console.error(`✗ wireframes: ${failures.length} problem(s)`);
    failures.forEach((f) => console.error(`  ${f}`));
    return 1;
  }
  console.log(`✓ wireframes: ${pages.length} pages at ${WIDTHS.join(' and ')} px; screenshots in scripts/wireframes/screenshots/`);
  return 0;
}

process.exitCode = await main();
