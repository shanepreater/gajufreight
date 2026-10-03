import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarios } from '../scenarios/index.js';
import { runScenarios } from '../lib/runner.js';
import { createNarrator } from '../lib/narrator.js';
import { createMemoryLog } from '../lib/audit-log.js';
import { SimChain } from '../lib/sim-chain.js';
import { Demo } from '../lib/demo.js';
import { DemoAssertionError } from '../lib/errors.js';
import { gaju } from '../lib/fixtures.js';

const silent = createNarrator({ silent: true });
const newDemo = () => new Demo({ chain: new SimChain(), narrator: silent, audit: createMemoryLog() });

describe('customer scenarios', () => {
  test('scenario ids are unique and kebab-case', () => {
    const ids = scenarios.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z]+(-[a-z]+)*$/);
  });

  for (const scenario of scenarios) {
    test(`${scenario.id} runs clean and keeps invariants`, async () => {
      const [result] = await runScenarios([scenario], { narrator: silent, audit: createMemoryLog() });
      assert.ok(result.ok, result.error?.stack);
    });
  }
});

describe('demo expectations fail loudly', () => {
  test('wrong expected code raises DemoAssertionError', () => {
    const d = newDemo();
    const s = d.book({ ref: 'T', amount: gaju(1), deadlineInDays: 1 });
    assert.throws(() => d.dispute('mallory', s, 'x', { expect: 'WRONG_AMOUNT' }), DemoAssertionError);
  });

  test('expected rejection that succeeds raises DemoAssertionError', () => {
    const d = newDemo();
    const s = d.book({ ref: 'T', amount: gaju(1), deadlineInDays: 1 });
    assert.throws(() => d.dispute('shipper', s, 'x', { expect: 'UNAUTHORIZED' }), /succeeded/);
  });

  test('unexpected contract rejection propagates with its code', () => {
    const d = newDemo();
    const s = d.book({ ref: 'T', amount: gaju(1), deadlineInDays: 1 });
    assert.throws(() => d.dispute('mallory', s, 'x'), { code: 'UNAUTHORIZED' });
  });

  test('feed expectation mismatch raises DemoAssertionError', () => {
    const d = newDemo();
    const event = { id: 'e1', type: 'X', location: 'L', occurredAt: '2026-10-01', source: 'carrier' };
    assert.throws(() => d.ingest(d.webhook(event), { expect: 'DUPLICATE' }), DemoAssertionError);
  });

  test('custody expectation mismatch raises DemoAssertionError', () => {
    const d = newDemo();
    const s = d.book({ ref: 'T', amount: gaju(1), deadlineInDays: 1 });
    assert.throws(() => d.expectCustody(s, 'C1', { state: 'in', location: 'Rotterdam' }), /never scanned/);
  });

  test('a withdrawn request takes no more quotes', () => {
    const d = newDemo();
    const q = d.requestQuotes({ ref: 'Q' });
    d.withdrawQuote('shipper', q);
    assert.ok(d.propose('forwarderA', q, { invitee: 'forwarderA', terms: { price: gaju(1), schedule: [] }, expect: 'BAD_STATE' }) === null);
  });

  test('agreement expectation mismatch raises DemoAssertionError', () => {
    const d = newDemo();
    const q = d.requestQuotes({ ref: 'Q' });
    assert.throws(() => d.expectAgreement(q, 'forwarderA', { price: gaju(1), schedule: [] }), DemoAssertionError);
  });

  test('scanning fails closed if the local manifest no longer matches the on-chain hash', () => {
    const d = newDemo();
    const s = d.book({ ref: 'T', amount: gaju(1), deadlineInDays: 1 });
    d.manifests.get(s).packages.push({ id: 'EXTRA', description: 'smuggled in' });
    assert.throws(() => d.scan('portAgent', s, { location: 'X', kind: 'ScanIn', labels: [] }), { code: 'MANIFEST_MISMATCH' });
  });

  test('a dropped scan checkpoint rolls its custody back', () => {
    const d = newDemo();
    const s = d.book({ ref: 'T', amount: gaju(1), deadlineInDays: 1 });
    d.scan('portAgent', s, { location: 'Rotterdam', kind: 'ScanIn', labels: [d.label(s, 'C1')] });
    d.dropLastMicroblock();
    assert.equal(d.custody.get(s).where('C1'), null);
  });

  test('booking with a quote the demo never saw reaches the contract and fails UNKNOWN_QUOTE', () => {
    const d = newDemo();
    const terms = { price: gaju(1), schedule: [] };
    assert.equal(d.book({ ref: 'X', quote: 'ct_demo_lookalike', terms, deadlineInDays: 1, expect: 'UNKNOWN_QUOTE' }), null);
  });

  test('waiting on a dropped transaction is an error', () => {
    const d = newDemo();
    const s = d.book({ ref: 'T', amount: gaju(1), deadlineInDays: 1 });
    const r = d.dispute('shipper', s, 'late');
    d.dropLastMicroblock();
    assert.throws(() => d.waitFinal(r), /dropped/);
  });
});

describe('runner', () => {
  test('continues after a failing scenario and reports it', async () => {
    const broken = { id: 'broken', title: 'Broken', summary: '', run: async () => { throw new Error('boom'); } };
    const audit = createMemoryLog();
    const results = await runScenarios([broken, scenarios[0]], { narrator: silent, audit });
    assert.deepEqual(results.map((r) => r.ok), [false, true]);
    assert.ok(audit.entries.some((e) => e.kind === 'scenario-end' && e.id === 'broken' && !e.ok));
  });

  test('invariant violation (Gaju created from nothing) fails the scenario', async () => {
    const minting = {
      id: 'minting', title: 'Minting', summary: '',
      run: async (d) => d.chain.createAccount('extra', 1n),
    };
    const [result] = await runScenarios([minting], { narrator: silent, audit: createMemoryLog() });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /total supply/);
  });

  test('dropping a dispute microblock returns the escrow to Funded, consistently', async () => {
    const fork = {
      id: 'fork', title: 'Fork', summary: '',
      async run(d) {
        const s = d.book({ ref: 'F', amount: gaju(5), deadlineInDays: 1 });
        d.dispute('shipper', s, 'late');
        d.dropLastMicroblock();
        d.expectStatus(s, 'Funded');
      },
    };
    const [result] = await runScenarios([fork], { narrator: silent, audit: createMemoryLog() });
    assert.ok(result.ok, result.error?.message);
  });

  test('audit log records every contract call outcome', async () => {
    const audit = createMemoryLog();
    await runScenarios([scenarios.find((s) => s.id === 'access-control')], { narrator: silent, audit });
    const calls = audit.entries.filter((e) => e.kind === 'call');
    assert.ok(calls.some((e) => e.outcome === 'rejected' && e.code === 'NOT_AGREED'));
    assert.ok(calls.some((e) => e.outcome === 'accepted' && e.txHash));
  });
});

describe('CLI', () => {
  const cli = fileURLToPath(new URL('../run-demo.js', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

  test('--list prints every scenario and exits 0', () => {
    const r = run('--list');
    assert.equal(r.status, 0);
    for (const s of scenarios) assert.match(r.stdout, new RegExp(s.id));
  });
  test('single scenario runs and exits 0', () => {
    const r = run('--fast', '-s', 'happy-path');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1\/1 scenarios passed/);
  });
  for (const [label, args] of [['unknown scenario', ['-s', 'nope']], ['unknown flag', ['--bogus']], ['unimplemented backend', ['--backend', 'local-chain']]]) {
    test(`${label} exits 2`, () => {
      assert.equal(run(...args).status, 2);
    });
  }
});

test('every error code a model can raise has a user-facing message', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { explain } = await import('../lib/errors.js');
  const dir = new URL('../lib/', import.meta.url);
  const codes = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const m of source.matchAll(/(?:require\([^;]*?|fail\(|new ContractError\()'([A-Z][A-Z_]+)'\)/g)) codes.add(m[1]);
  }
  assert.ok(codes.size > 20, `expected many codes, found ${codes.size}`);
  const missing = [...codes].filter((c) => explain(c) === 'unknown error');
  assert.deepEqual(missing, []);
});
