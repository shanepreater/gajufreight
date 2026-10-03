#!/usr/bin/env node
// Renders every logo SVG and fails if its drawing runs outside its viewBox, which
// would clip it (for example a descender in the wordmark). Local only (Playwright).
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const logoDir = resolve(here, '../../docs/brand/logo');
// The owner's original mark is kept as supplied until they decide how to redraw it.
const KNOWN = new Set(['logo-mark.svg']);

const overflow = () => {
  const svg = document.querySelector('svg');
  const [x, y, w, h] = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
  const b = svg.getBBox();
  const sides = { left: x - b.x, top: y - b.y, right: b.x + b.width - (x + w), bottom: b.y + b.height - (y + h) };
  return Object.entries(sides).filter(([, d]) => d > 0.01).map(([side, d]) => `${side} by ${d.toFixed(1)}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
const files = readdirSync(logoDir).filter((f) => f.endsWith('.svg') && !KNOWN.has(f)).sort();
for (const f of files) {
  await page.goto(pathToFileURL(join(logoDir, f)).href);
  const out = await page.evaluate(overflow);
  if (out.length) problems.push(`logo/${f}: drawing overflows its viewBox (${out.join(', ')})`);
}
await browser.close();
if (problems.length) {
  console.error(`✗ logos: ${problems.length} problem(s)`);
  problems.forEach((p) => console.error(`  ${p}`));
}
else console.log(`✓ logos: ${files.length} SVGs fit their viewBox`);
process.exitCode = problems.length ? 1 : 0;
