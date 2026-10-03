#!/usr/bin/env node
// Builds the committed CSS from the Tailwind inputs, so pages open by double-click
// with no build step. `--check` rebuilds in memory and fails if a committed file is stale.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
export const ENTRIES = [
  ['docs/brand/colour-chart.css', 'docs/brand/colour-chart.built.css'],
];
const BANNER = (src) => `/* Generated from ${src} by \`npm run build:css --prefix scripts/wireframes\`. Do not edit. */\n`;
const cli = join(here, 'node_modules/.bin/tailwindcss');

// Entries hold only brand imports and @source; Tailwind itself is imported from here,
// where node_modules resolves (Tailwind resolves imports relative to the input file).
// brand.css names its font relative to docs/brand; point it at the same file from each output.
const rebaseFonts = (css, out) => {
  const rel = relative(dirname(join(root, out)), join(root, 'docs/brand/fonts')) || '.';
  return css.replaceAll("url('fonts/", `url('${rel}/`);
};

export function build(src, out) {
  const dir = mkdtempSync(join(tmpdir(), 'gf-css-'));
  const entry = join(here, `.entry-${process.pid}.css`);
  writeFileSync(entry, `@import 'tailwindcss' source(none);\n@import '${join(root, src)}';\n`);
  try {
    execFileSync(cli, ['-i', entry, '-o', join(dir, 'out.css')], { cwd: root, stdio: 'pipe' });
    return BANNER(src) + rebaseFonts(readFileSync(join(dir, 'out.css'), 'utf8'), out);
  } finally {
    rmSync(entry, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [src, out] of ENTRIES) {
    const css = build(src, out);
    const path = join(root, out);
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== css) stale.push(out);
    } else {
      writeFileSync(path, css);
      console.log(`✓ built ${relative(root, path)}`);
    }
  }
  if (stale.length) {
    console.error(`✗ css: stale build output (run npm run build:css --prefix scripts/wireframes):\n  ${stale.join('\n  ')}`);
    return 1;
  }
  if (check) console.log(`✓ css: ${ENTRIES.length} built file(s) up to date`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
