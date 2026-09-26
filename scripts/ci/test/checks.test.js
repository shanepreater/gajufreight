import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidSegment, findInvalidPaths } from '../check-file-names.js';
import { slugify, headingAnchors, extractLinks, checkFile } from '../check-doc-links.js';
import { checkSubject, findAgentAttribution, checkCommits } from '../check-commits.js';

describe('file names', () => {
  for (const ok of ['hld.md', 'sim-chain.test.js', '.github', 'ci.yml', 'v2', 'README.md', 'SKILL.md', 'LICENSE', 'pull_request_template.md', '0001-use-groot.md']) {
    test(`accepts ${ok}`, () => assert.ok(isValidSegment(ok)));
  }
  for (const bad of ['dev_approach.md', 'ShipmentEscrow.aes', 'myFile.js', 'a--b.md', '-lead.md', 'trail-.md', 'with space.md', 'Readme.md', 'x.MD']) {
    test(`rejects ${bad}`, () => assert.ok(!isValidSegment(bad)));
  }
  test('checks every path segment, not just the file name', () => {
    assert.deepEqual(findInvalidPaths(['docs/ok.md', 'Docs/ok.md', 'docs/sub_dir/ok.md']), ['Docs/ok.md', 'docs/sub_dir/ok.md']);
  });

  describe('Python exception (PEP 8 snake_case)', () => {
    const ok = [
      'services/api/src/gajufreight_api/__init__.py',
      'services/api/src/gajufreight_api/health_check.py',
      'services/api/src/gajufreight_api/py.typed',
      'services/api/tests/test_health.py',
      'services/api/tests/conftest.py',
      'services/api/src/gajufreight_api/stubs.pyi',
    ];
    test('accepts snake_case modules, dunder files and package directories', () => {
      assert.deepEqual(findInvalidPaths(ok), []);
    });
    for (const bad of [
      'services/api/src/gajufreight_api/HealthCheck.py', // not snake_case
      'services/api/src/gajufreight_api/health-check.py', // hyphen not importable
      'services/api_service/pyproject.toml', // no .py directly inside: must stay kebab
      'services/api/src/gajufreight_api/data_file.json', // snake only for .py files
      'services/api/src/Bad_Pkg/__init__.py', // uppercase package
    ]) {
      test(`rejects ${bad}`, () => assert.deepEqual(findInvalidPaths([...ok, bad]), [bad]));
    }
  });
});

describe('doc links', () => {
  test('slugify follows GitHub anchor rules', () => {
    assert.equal(slugify('6.1 Escrow and waybill live in the same contract'), '61-escrow-and-waybill-live-in-the-same-contract');
    assert.equal(slugify('5. Contract sketch (Sophia)'), '5-contract-sketch-sophia');
    assert.equal(slugify('Data on-chain vs off-chain'), 'data-on-chain-vs-off-chain');
    assert.equal(slugify('Use `code` and **bold**'), 'use-code-and-bold');
    assert.equal(slugify('[Linked](x.md) heading'), 'linked-heading');
    assert.equal(slugify('Émigré café'), 'émigré-café');
    assert.equal(slugify('🚚 Trucks'), '-trucks');
  });

  test('duplicate headings get -1, -2 suffixes', () => {
    assert.deepEqual([...headingAnchors('# A\n## A\n### A')], ['a', 'a-1', 'a-2']);
  });

  test('headings and links inside code are ignored', () => {
    const md = '# Real\n```\n# Fake\n[x](missing.md)\n```\nSee `[y](nope.md)` and [z](real.md).';
    assert.deepEqual([...headingAnchors(md)], ['real']);
    assert.deepEqual(extractLinks(md), ['real.md']);
  });

  test('extracts images, titles and angle-bracket links', () => {
    assert.deepEqual(extractLinks('![i](a.png) [t](b.md "T") [u](<c.md>)'), ['a.png', 'b.md', 'c.md']);
  });

  function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), 'links-'));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return root;
  }

  test('reports missing files and missing anchors; accepts valid ones', () => {
    const root = fixture({
      'docs/a.md': '# Title\n[ok](b.md#section-two) [dir](../docs/) [self](#title) [ext](https://x.y/z) [mail](mailto:a@b.c)\n[bad file](nope.md) [bad anchor](b.md#missing) [bad self](#nope)',
      'docs/b.md': '# B\n## Section two',
    });
    const problems = checkFile('docs/a.md', { root }).map((p) => `${p.href}: ${p.problem}`);
    assert.deepEqual(problems, ['nope.md: target does not exist', 'b.md#missing: no heading for #missing', '#nope: no heading for #nope']);
  });

  test('anchors on non-Markdown targets are not checked', () => {
    const root = fixture({ 'a.md': '[f](run.js#L10)', 'run.js': '' });
    assert.deepEqual(checkFile('a.md', { root }), []);
  });
});

describe('commits', () => {
  for (const s of ['feat: add x', 'fix(contracts): guard refund', 'ci!: drop node 20', 'docs(agents): y', 'Merge pull request #7 from a/b', 'Revert "feat: x"']) {
    test(`accepts "${s}"`, () => assert.equal(checkSubject(s), null));
  }
  for (const s of ['Add stuff', 'feat:missing space', 'feature: x', 'Feat: x', 'feat(Bad_Scope): x', 'feat: ']) {
    test(`rejects "${s}"`, () => assert.match(checkSubject(s), /Conventional/));
  }
  test('subject length boundary: 72 ok, 73 rejected', () => {
    const at = (n) => `feat: ${'x'.repeat(n - 6)}`;
    assert.equal(checkSubject(at(72)), null);
    assert.match(checkSubject(at(73)), /73 chars/);
  });

  test('flags agent co-authors and generated-by footers, allows humans', () => {
    const body = [
      'feat: x',
      '',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      'Co-authored-by: Copilot <copilot@github.com>',
      'Co-authored-by: dependabot[bot] <x@users.noreply.github.com>',
      'Co-authored-by: Jane Doe <jane@example.com>',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].join('\n');
    assert.equal(findAgentAttribution(body).length, 4);
    assert.deepEqual(findAgentAttribution('Co-authored-by: Jane Doe <jane@example.com>'), []);
  });

  test('checkCommits reports subject and attribution problems per commit', () => {
    const problems = checkCommits([
      { sha: 'a'.repeat(40), subject: 'feat: ok', body: 'feat: ok' },
      { sha: 'b'.repeat(40), subject: 'bad subject', body: 'bad subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>' },
    ]);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((p) => p.startsWith('bbbbbbb')));
  });
});
