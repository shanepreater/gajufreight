import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explain } from '../lib/errors.js';

// The interface catalogue is generated from the contracts (contracts/tools/build.escript),
// so a new error code there fails this test until it has a plain-language message.
const catalogue = JSON.parse(readFileSync(new URL('../../../contracts/interface/errors.json', import.meta.url)));

test('every contract error code has a message', () => {
  const codes = [...new Set(catalogue.map((entry) => entry.code))];
  const missing = codes.filter((code) => explain(code) === 'unknown error');
  assert.deepEqual(missing, []);
  assert.ok(codes.length >= 50);
});
