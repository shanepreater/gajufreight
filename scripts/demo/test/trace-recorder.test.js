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
import { CONSIGNMENT } from '../lib/fixtures.js';

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
    assert.deepEqual(call.args, [{ $variant: ['SetEscrowTemplate', { $addr: 'ShipmentEscrow#1' }] }]);
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
  test('a hash the contracts compute themselves, by what it was made of, only at a hash position', () => {
    const { chain, admin, platform, steps } = recorded();
    installFor(chain, platform, admin);
    chain.call(platform, 'propose', { change: { type: 'SetVerifier', verifier: admin } }, { caller: admin });
    const job = jobHash({ manifest: 'm'.repeat(64), consignee: 'ak_demo_k' });
    chain.call(platform, 'verify', { account: admin, commitment: job, expires: 9, roles: ['Arbiter'] }, { caller: admin });
    assert.deepEqual(steps().at(-1).args, [
      { $addr: 'admin' }, { $hash: { kind: 'job', of: { manifest: 'm'.repeat(64), consignee: { $addr: 'k' } } } }, 9, [{ $variant: ['Arbiter'] }],
    ]);
  });
});

describe('values are encoded as the contract\'s type at each position', () => {
  const quoteWith = (dispute) => {
    const t = recorded();
    installFor(t.chain, t.platform, t.admin);
    t.chain.call(t.platform, 'propose', { change: { type: 'SetVerifier', verifier: t.admin } }, { caller: t.admin });
    t.chain.call(t.platform, 'verify', { account: 'ak_demo_arb', commitment: 'c'.repeat(64), expires: 99, roles: ['Arbiter'] }, { caller: t.admin });
    const { result: quote } = t.chain.call(t.platform, 'new_quote', { invited: ['ak_demo_f'], job: 'j'.repeat(64), consignment: CONSIGNMENT, dispute: { panel: ['ak_demo_arb'], quorum: 1, window: 1, fallback: 50, challenge: 1, ...dispute } }, { caller: t.admin });
    return { ...t, quote };
  };
  test('records in the contract\'s field order; an option field the model leaves out is None', () => {
    const { steps } = quoteWith({});
    const [, , consignment, dispute, parent] = steps().at(-1).args;
    assert.deepEqual(Object.keys(dispute), ['panel', 'quorum', 'window', 'fallback', 'challenge']);
    assert.equal(consignment.deliver_by, CONSIGNMENT.deliverBy);
    assert.equal(parent, null);
  });
  test('a field the contract lacks makes the trace unreplayable', () => {
    const { trace } = quoteWith({ colour: 'red' });
    assert.match(trace.toJSON().unreplayable, /fields the contract lacks: colour/);
  });
  test('a fraction where the contract takes a whole number makes the trace unreplayable', () => {
    const { chain, admin, platform, trace } = recorded();
    assert.throws(() => chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'max_panel', value: 1.5 } }, { caller: admin }), { code: 'BAD_SETTING' });
    assert.match(trace.toJSON().unreplayable, /1.5 is not a whole number/);
  });
  test('an account where the contract takes a contract makes the trace unreplayable', () => {
    const { chain, admin, platform, trace } = recorded();
    assert.throws(() => chain.call(platform, 'book', { quote: admin, manifest: 'm'.repeat(64) }, { caller: admin }), { code: 'UNKNOWN_QUOTE' });
    assert.match(trace.toJSON().unreplayable, /is not a contract/);
  });
  test('a hash that is not 32 bytes makes the trace unreplayable', () => {
    const { chain, admin, platform, trace } = recorded();
    assert.throws(() => chain.call(platform, 'book', { quote: platform, manifest: 'short' }, { caller: admin }));
    assert.match(trace.toJSON().unreplayable, /'short' is not 32 bytes/);
  });
  test('a result in a shape the contract doesn\'t return is recorded as untyped, and the trace stays replayable', () => {
    const { chain, admin, trace, steps } = recorded();
    // A stand-in whose treasury view returns a number where the contract returns an address.
    const Odd = { name: 'Platform', init: () => ({}), views: { treasury: () => 7 }, entrypoints: {} };
    const { result: odd } = chain.deploy(Odd, admin, { admins: [admin], quorum: 1, treasury: admin });
    chain.view(odd, 'treasury');
    assert.match(steps().at(-1).result.$untyped, /7 is not an address/);
    assert.equal(trace.toJSON().unreplayable, null);
  });
  test('a result that types is recorded as the contract returns it', () => {
    const { chain, quote, steps } = quoteWith({});
    chain.call(quote, 'quote', { terms: { price: 5n, schedule: [], deadline: 2, attestors: [] }, validUntil: 9 }, { caller: chain.createAccount('f', 0n) });
    chain.view(quote, 'thread', { invitee: 'ak_demo_f' });
    assert.deepEqual(steps().at(-1).result, {
      quote: { terms: { price: { $int: '5' }, schedule: [], deadline: 2, attestors: [], replace: null }, valid_until: 9, round: 1 },
      counter: null, counters: 0, declined: false,
    });
  });
});

test('a second recorder on the same chain leaves the first one recording', () => {
  const { chain, trace } = recorded();
  const second = new TraceRecorder(chain);
  chain.createAccount('late', 1n);
  assert.deepEqual(trace.toJSON().steps.at(-1), { op: 'account', account: 'late', balance: { $int: '1' } });
  assert.deepEqual(second.toJSON().steps, [{ op: 'account', account: 'late', balance: { $int: '1' } }]);
});

test('bytes, such as a salt, are never tagged as a hash the contracts compute', () => {
  const { chain, platform, steps } = recorded();
  const salt = jobHash({ manifest: 's'.repeat(64), consignee: null });
  chain.view(platform, 'matches', { account: 'ak_demo_x', name: 'n', country: 'c', number: '1', salt });
  assert.equal(steps().at(-1).args[4], salt);
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
  test('an event field the contract couldn\'t carry marks the trace', () => {
    const { chain, admin, trace } = recorded();
    const Odd = { name: 'Platform', init: (ctx) => { ctx.emit({ type: 'Applied', id: 1.5 }); return {}; }, views: {}, entrypoints: {} };
    chain.deploy(Odd, admin, { admins: [admin], quorum: 1, treasury: admin });
    assert.match(trace.toJSON().unreplayable, /Platform.Applied event: "int": 1.5 is not a whole number/);
  });
  test('a step whose event can\'t be projected is still recorded', () => {
    const { chain, admin, steps } = recorded();
    const Noisy = { name: 'Platform', init: (ctx) => { ctx.emit({ type: 'Surprise' }); return {}; }, views: {}, entrypoints: {} };
    chain.deploy(Noisy, admin, { admins: [admin], quorum: 1, treasury: admin });
    assert.partialDeepStrictEqual(steps().at(-1), { op: 'deploy', as: 'Platform#2', events: [{ contract: 'Platform#2', event: ['Surprise'] }] });
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
