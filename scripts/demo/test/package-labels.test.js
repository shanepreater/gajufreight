import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLabel, parseLabel, buildManifest, manifestHash } from '../lib/package-labels.js';

const CONTRACT = 'ct_demo_ShipmentEscrow_1';

describe('labels', () => {
  test('encode → parse round-trips', () => {
    const text = encodeLabel(CONTRACT, 'GF-0008-P1');
    assert.equal(text, 'gajufreight://s/ct_demo_ShipmentEscrow_1/p/GF-0008-P1');
    assert.deepEqual(parseLabel(text), { contract: CONTRACT, packageId: 'GF-0008-P1' });
  });

  test('parsing tolerates surrounding whitespace from scanners', () => {
    assert.equal(parseLabel(`  ${encodeLabel(CONTRACT, 'P1')}\n`).packageId, 'P1');
  });

  for (const [label, text] of [
    ['empty', ''],
    ['not a string', undefined],
    ['wrong scheme', 'https://s/ct_x/p/P1'],
    ['missing package', 'gajufreight://s/ct_x/p/'],
    ['missing contract', 'gajufreight://s//p/P1'],
    ['extra path', 'gajufreight://s/ct_x/p/P1/extra'],
    ['lowercase package id', 'gajufreight://s/ct_x/p/p1'],
    ['package id too long (33)', `gajufreight://s/ct_x/p/${'P'.repeat(33)}`],
    ['injected characters', 'gajufreight://s/ct_x/p/P1<script>'],
  ]) {
    test(`rejects ${label} (BAD_LABEL)`, () => {
      assert.throws(() => parseLabel(text), { code: 'BAD_LABEL' });
    });
  }

  test('accepts the longest package id (32)', () => {
    assert.equal(parseLabel(`gajufreight://s/ct_x/p/${'P'.repeat(32)}`).packageId.length, 32);
  });

  test('encoding rejects ids it could not parse back', () => {
    assert.throws(() => encodeLabel(CONTRACT, 'bad id'), { code: 'BAD_LABEL' });
  });
});

describe('manifest', () => {
  const packages = [
    { id: 'P2', description: 'Pallet 2: kitchenware' },
    { id: 'P1', description: 'Pallet 1: lamps' },
  ];

  test('hash is independent of package order', () => {
    assert.equal(manifestHash(buildManifest(packages)), manifestHash(buildManifest([...packages].reverse())));
  });

  test('hash changes when any package changes', () => {
    const changed = [{ ...packages[0], description: 'Pallet 2: glassware' }, packages[1]];
    assert.notEqual(manifestHash(buildManifest(packages)), manifestHash(buildManifest(changed)));
  });

  test('lists package ids in a stable order', () => {
    assert.deepEqual(buildManifest(packages).packages.map((p) => p.id), ['P1', 'P2']);
  });

  for (const [label, list] of [
    ['empty', []],
    ['duplicate ids', [{ id: 'P1', description: 'a' }, { id: 'P1', description: 'b' }]],
    ['malformed id', [{ id: 'p 1', description: 'a' }]],
    ['not a list', undefined],
  ]) {
    test(`rejects a manifest that is ${label} (BAD_MANIFEST)`, () => {
      assert.throws(() => buildManifest(list), { code: 'BAD_MANIFEST' });
    });
  }
});

describe('strict encoding (review #16)', () => {
  for (const [label, contract, id] of [
    ['a contract id with a path separator', 'ct_x/evil', 'P1'],
    ['a numeric contract id', 123, 'P1'],
    ['a numeric package id', CONTRACT, 123],
    ['an empty contract id', '', 'P1'],
  ]) {
    test(`encodeLabel rejects ${label} (BAD_LABEL)`, () => {
      assert.throws(() => encodeLabel(contract, id), { code: 'BAD_LABEL' });
    });
  }
  test('buildManifest rejects numeric ids even if they look valid (BAD_MANIFEST)', () => {
    assert.throws(() => buildManifest([{ id: 123, description: 'x' }]), { code: 'BAD_MANIFEST' });
  });
});
