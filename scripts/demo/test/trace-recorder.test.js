// The trace recorder (#70): what a chain runner needs to replay a test against the contracts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimChain } from '../lib/sim-chain.js';
import { TraceRecorder } from '../lib/trace-recorder.js';
import { Platform } from '../lib/platform.js';
import { jobHash } from '../lib/quote-request.js';
import { installFor } from './support.js';

function recorded() {
  const chain = new SimChain();
  const trace = new TraceRecorder(chain);
  const admin = chain.createAccount('admin', 5n);
  const { result: platform } = chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury: 'ak_demo_treasury' });
  return { chain, trace, admin, platform, steps: () => trace.toJSON().steps };
}

describe('what a trace records', () => {
  test('accounts by name, with their opening balance', () => {
    const { steps } = recorded();
    assert.deepEqual(steps()[0], { op: 'account', account: 'admin', balance: { $int: '5' } });
  });
  test('a deploy: its arguments in the contract\'s order, and the label the new contract gets', () => {
    const { steps } = recorded();
    assert.partialDeepStrictEqual(steps()[1], {
      op: 'deploy', caller: 'admin', contract: 'Platform', height: 1,
      args: [[{ $addr: 'admin' }], 1, { $addr: 'treasury' }], value: { $int: '0' }, as: 'Platform#1', events: [], balances: {},
    });
  });
  test('a call: the contract by label, events in the contract\'s field order, and clones it created', () => {
    const { chain, admin, platform, steps } = recorded();
    installFor(chain, platform, admin);
    const call = steps().find((s) => s.function === 'propose' && s.events.some((e) => e.event[0] === 'Applied'));
    assert.equal(call.contract, 'Platform#1');
    assert.deepEqual(call.events.map((e) => e.event), [['Proposed', 0, { $addr: 'admin' }], ['Applied', 0]]);
    assert.deepEqual(call.args, [{ type: 'SetEscrowTemplate', template: { $addr: 'ShipmentEscrow#1' } }]);
  });
  test('a rejected call: its error code, and no effects', () => {
    const { chain, platform, steps } = recorded();
    const stranger = chain.createAccount('stranger', 0n);
    assert.throws(() => chain.call(platform, 'approve', { id: 9 }, { caller: stranger }));
    assert.partialDeepStrictEqual(steps().at(-1), { op: 'call', caller: 'stranger', function: 'approve', args: [9], error: 'ONLY_ADMIN' });
    assert.equal(steps().at(-1).events, undefined);
  });
  test('a view and its result; key blocks passing', () => {
    const { chain, platform, steps } = recorded();
    chain.view(platform, 'setting', { key: 'max_panel' });
    chain.advanceKeyblocks(3);
    assert.partialDeepStrictEqual(steps().at(-2), { op: 'view', contract: 'Platform#1', function: 'setting', args: ['max_panel'], result: 7 });
    assert.deepEqual(steps().at(-1), { op: 'advance', keyblocks: 3 });
  });
  test('balance changes by label, and a hash the contracts compute themselves, by what it was made of', () => {
    const { trace } = recorded();
    const job = jobHash({ manifest: 'm', consignee: 'ak_demo_k' });
    assert.deepEqual(trace.encode(job), { $hash: { kind: 'job', of: { manifest: 'm', consignee: { $addr: 'k' } } } });
    assert.deepEqual(trace.encode({ minArbiterFee: 2n }), { min_arbiter_fee: { $int: '2' } });
  });
});

describe('what a trace can\'t replay', () => {
  test('a dropped microblock', () => {
    const { chain, trace } = recorded();
    chain.dropLastMicroblock();
    assert.match(trace.toJSON().unreplayable, /dropped microblock/);
  });
  test('an entrypoint the contract lacks, without changing the test\'s outcome', () => {
    const { chain, admin, platform, trace } = recorded();
    assert.throws(() => chain.call(platform, 'add_leg', {}, { caller: admin }), { code: 'UNKNOWN_ENTRYPOINT' });
    assert.match(trace.toJSON().unreplayable, /add_leg is not in the contract's interface/);
  });
  test('a contract that is not one of ours', () => {
    const { chain, admin, trace } = recorded();
    chain.deploy({ name: 'Toy', init: () => ({}), views: {}, entrypoints: {} }, admin, {});
    assert.match(trace.toJSON().unreplayable, /Toy is not one of the contracts/);
  });
  test('anything else the recorder can\'t record (an event no contract emits) marks the trace, never the test', () => {
    const { chain, admin, trace } = recorded();
    const Noisy = { name: 'Platform', init: (ctx) => { ctx.emit({ type: 'Surprise' }); return {}; }, views: {}, entrypoints: {} };
    assert.doesNotThrow(() => chain.deploy(Noisy, admin, { admins: [admin], quorum: 1, treasury: admin }));
    assert.match(trace.toJSON().unreplayable, /Platform emits no Surprise event/);
  });
  test('only the first reason is kept', () => {
    const { chain, trace } = recorded();
    chain.dropLastMicroblock();
    chain.deploy({ name: 'Toy', init: () => ({}), views: {}, entrypoints: {} }, chain.createAccount('x', 0n), {});
    assert.match(trace.toJSON().unreplayable, /dropped microblock/);
  });
});

test('with TRACE_DIR set, the hook writes each run\'s traces to <script>.jsonl, one per line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traces-'));
  const demo = fileURLToPath(new URL('..', import.meta.url));
  const script = join(demo, 'test', 'support', 'two-chains.mjs');
  const run = spawnSync(process.execPath, ['--import', './lib/trace-hook.js', script], { cwd: demo, env: { ...process.env, TRACE_DIR: dir } });
  assert.equal(run.status, 0, run.stderr.toString());
  assert.deepEqual(readdirSync(dir), ['two-chains.mjs.jsonl']);
  const lines = readFileSync(join(dir, 'two-chains.mjs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, 'a chain with no steps writes nothing');
  assert.deepEqual(lines.map((t) => t.steps[0].account), ['a', 'b']);
});
