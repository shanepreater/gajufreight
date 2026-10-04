#!/usr/bin/env node
// Loads every wireframe (and the brand colour chart) in a real browser at phone and
// desktop widths, in light and dark, and checks the ux-designer basics: no horizontal
// page scroll, internal links and anchors resolve, controls and images are labelled,
// touch targets are at least 44 px, and rendered text meets WCAG AA contrast.
// Local only (no CI minutes). Screenshots go to ./screenshots (git-ignored).
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = resolve(here, '../../docs/wireframes');
const chartPage = resolve(here, '../../docs/brand/colour-chart.html');
const SCHEMES = ['light', 'dark'];
const shotsDir = join(here, 'screenshots');
const WIDTHS = [390, 1280];
const MIN_TARGET = 44;

// Runs inside the page: returns a list of problems found on it.
function auditPage(minTarget) {
  const problems = [];
  // Contrast: every element with its own text, against the first opaque background
  // behind it. Disabled controls are exempt (WCAG 1.4.3); text on a gradient is skipped.
  const rgb = (c) => c.match(/[\d.]+/g).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const backdrop = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null;
      const c = rgb(cs.backgroundColor);
      if (c.length < 4 || c[3] === 1) return c;
    }
    return [255, 255, 255];
  };
  for (const el of document.querySelectorAll('body *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || !el.getClientRects().length || el.closest(':disabled, [aria-disabled="true"]')) continue;
    const cs = getComputedStyle(el);
    const bg = backdrop(el);
    if (!bg || cs.visibility === 'hidden') continue;
    const [hi, lo] = [lum(rgb(cs.color)), lum(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const min = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio < min - 0.005) problems.push(`contrast ${ratio.toFixed(2)}:1 < ${min}:1 (${cs.color} on rgb(${bg.slice(0, 3)})): "${el.textContent.trim().slice(0, 40)}"`);
  }
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

// Runs inside the page: forces a theme the way a host page does (data-theme on <html>,
// against the opposite system setting) and checks every visible logo matches it.
function auditForcedTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const wrong = [];
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.src;
    if (!src.includes('/logo/') || !img.getClientRects().length) continue;
    if (src.includes('-dark.svg') !== (theme === 'dark')) wrong.push(src.split('/logo/')[1]);
  }
  return wrong.map((f) => `forced ${theme} theme shows the ${theme === 'dark' ? 'light' : 'dark'} logo ${f}`);
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });
  const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.html')).sort();
  const browser = await chromium.launch();
  const failures = [];
  const idsByPage = new Map();
  const linksByPage = new Map();

  for (const colorScheme of SCHEMES) {
    for (const width of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
      for (const file of [...pages, chartPage]) {
        await page.goto(pathToFileURL(file === chartPage ? chartPage : join(pagesDir, file)).href);
        await page.evaluate(() => document.fonts.ready);
        const { problems, links, ids } = await page.evaluate(auditPage, MIN_TARGET);
        const name = file === chartPage ? 'colour-chart.html' : file;
        problems.forEach((p) => failures.push(`${name} @${width}px ${colorScheme}: ${p}`));
        if (file === chartPage) continue; // its links point at brand docs, not wireframes
        idsByPage.set(file, new Set(ids));
        linksByPage.set(file, links);
        const suffix = colorScheme === 'light' ? '' : `-${colorScheme}`;
        await page.screenshot({ path: join(shotsDir, `${file.replace('.html', '')}-${width}${suffix}.png`), fullPage: true });
      }
      await page.close();
    }
  }
  // A host can force either theme against the system setting; logos must follow it.
  for (const [colorScheme, theme] of [['light', 'dark'], ['dark', 'light']]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme });
    for (const file of pages) {
      await page.goto(pathToFileURL(join(pagesDir, file)).href);
      (await page.evaluate(auditForcedTheme, theme)).forEach((p) => failures.push(`${file}: ${p}`));
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
  console.log(`✓ wireframes: ${pages.length} pages and the colour chart at ${WIDTHS.join(' and ')} px, light and dark; screenshots in scripts/wireframes/screenshots/`);
  return 0;
}

process.exitCode = await main();
