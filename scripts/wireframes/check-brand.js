#!/usr/bin/env node
// Keeps the brand in step (docs/brand/brand-guide.md):
// - brand.css: both dark blocks match, and every theme defines the same tokens;
// - the guide's token table matches brand.css, and its contrast table matches the
//   recomputed ratios, each meeting its minimum;
// - the colour chart lists the same tokens and pairs as the guide;
// - brand pages have no inline styles, and logos have no raster images.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast } from './lib/contrast.js';

const here = dirname(fileURLToPath(import.meta.url));
const brandDir = resolve(here, '../../docs/brand');
const read = (f) => readFileSync(join(brandDir, f), 'utf8');

export function tokensIn(css, selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`brand.css: no block "${selector}"`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--gf-([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(([, k, v]) => [k, v.toUpperCase()]));
}

const rows = (md, header) => {
  const at = md.indexOf(header);
  if (at < 0) return [];
  const lines = md.slice(at).split('\n').slice(2);
  const end = lines.findIndex((l) => !l.startsWith('|'));
  return lines.slice(0, end < 0 ? undefined : end).map((l) => l.split('|').slice(1, -1).map((c) => c.trim().replaceAll('`', '')));
};
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

export function checkBrand({ css, guide, chart, pages, logos }) {
  const problems = [];
  const light = tokensIn(css, ":root, [data-theme='light'] {");
  const dark = tokensIn(css, "\n[data-theme='dark'] {");
  const media = tokensIn(css, ":root:not([data-theme='light']) {");
  const names = new Set(Object.keys(light));
  for (const [label, theme] of [['dark', dark], ['system dark', media]]) {
    if (!same(names, new Set(Object.keys(theme)))) problems.push(`brand.css: ${label} tokens differ from light`);
  }
  for (const k of names) if (dark[k] !== media[k]) problems.push(`brand.css: --gf-${k} is ${dark[k]} for [data-theme=dark] but ${media[k]} for system dark`);

  const tokenRows = rows(guide, '| Token | Light | Dark | Use |');
  if (!same(names, new Set(tokenRows.map((r) => r[0])))) problems.push('guide: token table lists different tokens from brand.css');
  for (const [k, l, d] of tokenRows) {
    if (light[k] !== l?.toUpperCase()) problems.push(`guide: ${k} light is ${l}, brand.css has ${light[k]}`);
    if (dark[k] !== d?.toUpperCase()) problems.push(`guide: ${k} dark is ${d}, brand.css has ${dark[k]}`);
  }

  const pairRows = rows(guide, '| Text or mark | On | Use | Needs | Light | Dark |');
  if (!pairRows.length) problems.push('guide: no contrast table');
  for (const [fg, bg, , needs, l, d] of pairRows) {
    const min = parseFloat(needs);
    for (const [label, theme, stated] of [['light', light, l], ['dark', dark, d]]) {
      if (!theme[fg] || !theme[bg]) { problems.push(`guide: pair ${fg}/${bg} uses an unknown token`); continue; }
      const actual = contrast(theme[fg], theme[bg]);
      if (actual.toFixed(2) !== parseFloat(stated).toFixed(2)) problems.push(`guide: ${fg} on ${bg} (${label}) says ${stated}, actual ${actual.toFixed(2)}:1`);
      if (actual < min) problems.push(`${fg} on ${bg} (${label}) is ${actual.toFixed(2)}:1, below ${min}:1`);
    }
  }

  const chartPairs = new Set([...chart.matchAll(/data-pair="([a-z-]+\/[a-z-]+)" data-min="([\d.]+)"/g)].map(([, p, m]) => `${p}@${parseFloat(m)}`));
  const guidePairs = new Set(pairRows.map(([fg, bg, , n]) => `${fg}/${bg}@${parseFloat(n)}`));
  if (!same(chartPairs, guidePairs)) problems.push('colour chart: approved pairs differ from the guide');
  const chartTokens = new Set([...chart.matchAll(/data-token="([a-z-]+)"/g)].map(([, t]) => t));
  if (!same(chartTokens, names)) problems.push('colour chart: swatches differ from brand.css tokens');

  for (const [file, html] of pages) if (/\sstyle=/.test(html)) problems.push(`${file}: inline style= (use a utility or component class)`);
  for (const [file, svg] of logos) if (/<image\b|data:image\/(png|jpe?g|gif|webp)/i.test(svg)) problems.push(`${file}: embedded raster image`);
  return problems;
}

function main() {
  const problems = checkBrand({
    css: read('brand.css'),
    guide: read('brand-guide.md'),
    chart: read('colour-chart.html'),
    pages: readdirSync(brandDir).filter((f) => f.endsWith('.html')).map((f) => [f, read(f)]),
    logos: readdirSync(join(brandDir, 'logo')).filter((f) => f.endsWith('.svg')).map((f) => [`logo/${f}`, read(`logo/${f}`)]),
  });
  if (problems.length) {
    console.error(`✗ brand: ${problems.length} problem(s)`);
    problems.forEach((p) => console.error(`  ${p}`));
    return 1;
  }
  console.log('✓ brand: tokens, guide and chart agree; all approved pairs meet WCAG AA');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
