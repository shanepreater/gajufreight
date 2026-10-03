import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkBrand } from './check-brand.js';
import { contrast } from './lib/contrast.js';

const read = (f) => readFileSync(new URL(`../../docs/brand/${f}`, import.meta.url), 'utf8');
const real = () => ({ css: read('brand.css'), guide: read('brand-guide.md'), chart: read('colour-chart.html'), pages: [], logos: [] });
const has = (problems, text) => assert.ok(problems.some((p) => p.includes(text)), `expected "${text}" in:\n${problems.join('\n')}`);

test('the committed brand files agree', () => {
  assert.deepEqual(checkBrand(real()), []);
});

test('contrast matches WCAG reference values', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(2), '21.00');
  assert.equal(contrast('#FFFFFF', '#FFFFFF').toFixed(2), '1.00');
  assert.equal(contrast('#FF5722', '#FFFFFF').toFixed(2), '3.16');
});

test('a brand.css colour the guide does not list is caught', () => {
  const b = real();
  b.css = b.css.replace('--gf-muted: #4B5563;', '--gf-muted: #4B5564;');
  has(checkBrand(b), 'muted light is #4B5563');
});

test('a pair that drops below its minimum is caught', () => {
  const b = real();
  b.css = b.css.replace('--gf-accent-text: #C2410C;', '--gf-accent-text: #FF5722;');
  has(checkBrand(b), 'accent-text on surface (light) is 3.16:1, below 4.5:1');
});

test('the two dark blocks must not drift apart', () => {
  const b = real();
  b.css = b.css.replace("[data-theme='dark'] {\n  --gf-surface: #111827;", "[data-theme='dark'] {\n  --gf-surface: #000000;");
  has(checkBrand(b), '--gf-surface is #000000 for [data-theme=dark] but #111827 for system dark');
});

test('a chart missing an approved pair is caught', () => {
  const b = real();
  b.chart = b.chart.replaceAll('data-pair="ink/danger-surface"', 'data-pair="ink/surface-alt"');
  has(checkBrand(b), 'approved pairs differ');
});

test('a stated ratio that is wrong is caught', () => {
  const b = real();
  b.guide = b.guide.replace('| Body text | 4.5:1 | 17.74:1 |', '| Body text | 4.5:1 | 18.00:1 |');
  has(checkBrand(b), 'ink on surface (light) says 18.00:1');
});

test('inline styles and raster logos are rejected', () => {
  const b = { ...real(), pages: [['x.html', '<p style="color:red">']], logos: [['logo/x.svg', '<svg><image href="data:image/png;base64,AA"/></svg>']] };
  const problems = checkBrand(b);
  has(problems, 'x.html: inline style=');
  has(problems, 'logo/x.svg: embedded raster image');
});
