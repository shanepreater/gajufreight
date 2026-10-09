import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { Platform } from '../lib/platform.js';
import { QuoteRequest } from '../lib/quote-request.js';
import { CONSIGNMENT } from '../lib/fixtures.js';

const DISPUTE = { panel: ['ak_demo_arbiter'], quorum: 1, window: 2, fallback: 50, challenge: 1 };

const ROLES = ['admin1', 'admin2', 'admin3', 'shipper', 'fwd', 'stranger'];

function setup({ quorum = 2, admins = ['admin1', 'admin2', 'admin3'] } = {}) {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 100n)]));
  const { result: id } = chain.deploy(Platform, a.admin1, { admins: admins.map((r) => a[r]), quorum, treasury: 'ak_demo_treasury' });
  const call = (role, ep, args = {}) => chain.call(id, ep, args, { caller: a[role] });
  const setting = (key) => chain.view(id, 'setting', { key });
  const set = (key, value) => ({ type: 'SetSetting', key, value });
  return { chain, a, id, call, setting, set };
}

describe('init', () => {
  for (const [label, admins, quorum] of [['quorum 0', 3, 0], ['quorum above the admin count', 3, 4], ['no admins', 0, 1], ['a fractional quorum', 3, 1.5]]) {
    test(`rejects ${label} (BAD_QUORUM)`, () => {
      const chain = new SimChain();
      const xs = Array.from({ length: admins }, (_, i) => chain.createAccount(`a${i}`, 0n));
      assert.throws(() => chain.deploy(Platform, chain.createAccount('d', 0n), { admins: xs, quorum, treasury: 'ak_demo_treasury' }), { code: 'BAD_QUORUM' });
    });
  }
  test('rejects duplicate admins (BAD_QUORUM)', () => {
    const chain = new SimChain();
    const x = chain.createAccount('x', 0n);
    assert.throws(() => chain.deploy(Platform, x, { admins: [x, x], quorum: 2, treasury: 'ak_demo_treasury' }), { code: 'BAD_QUORUM' });
  });
  test('starts with max_rounds 3 and max_panel 7', () => {
    const t = setup();
    assert.equal(t.setting('max_rounds'), 3);
    assert.equal(t.setting('max_panel'), 7);
  });
});

describe('settings change only by admin quorum', () => {
  test('one approval (the proposer) is not enough for a 2-of-3 change', () => {
    const t = setup();
    t.call('admin1', 'propose', { change: t.set('max_rounds', 5) });
    assert.equal(t.setting('max_rounds'), 3);
  });
  test('the second admin approval applies it', () => {
    const t = setup();
    const { result: id } = t.call('admin1', 'propose', { change: t.set('max_rounds', 5) });
    t.call('admin2', 'approve', { id });
    assert.equal(t.setting('max_rounds'), 5);
  });
  test('approving twice yourself still counts once', () => {
    const t = setup();
    const { result: id } = t.call('admin1', 'propose', { change: t.set('max_rounds', 5) });
    t.call('admin1', 'approve', { id });
    assert.equal(t.setting('max_rounds'), 3);
  });
  test('with quorum 1, proposing applies immediately; with quorum 3, all three are needed', () => {
    const one = setup({ quorum: 1 });
    one.call('admin2', 'propose', { change: one.set('max_panel', 5) });
    assert.equal(one.setting('max_panel'), 5);
    const all = setup({ quorum: 3 });
    const { result: id } = all.call('admin1', 'propose', { change: all.set('max_panel', 5) });
    all.call('admin2', 'approve', { id });
    assert.equal(all.setting('max_panel'), 7);
    all.call('admin3', 'approve', { id });
    assert.equal(all.setting('max_panel'), 5);
  });
  test('non-admins cannot propose or approve (ONLY_ADMIN)', () => {
    const t = setup();
    assert.throws(() => t.call('stranger', 'propose', { change: t.set('max_rounds', 99) }), { code: 'ONLY_ADMIN' });
    const { result: id } = t.call('admin1', 'propose', { change: t.set('max_rounds', 5) });
    assert.throws(() => t.call('shipper', 'approve', { id }), { code: 'ONLY_ADMIN' });
  });
  for (const [label, change] of [
    ['an unknown setting', { type: 'SetSetting', key: 'fee', value: 1 }],
    ['a value of 0', { type: 'SetSetting', key: 'max_rounds', value: 0 }],
    ['a fractional value', { type: 'SetSetting', key: 'max_rounds', value: 2.5 }],
    ['an unknown change type', { type: 'Drop', key: 'max_rounds' }],
  ]) {
    test(`rejects ${label} (BAD_SETTING)`, () => {
      const t = setup();
      assert.throws(() => t.call('admin1', 'propose', { change }), { code: 'BAD_SETTING' });
    });
  }
  test('approving an unknown or already-applied proposal is NO_PROPOSAL', () => {
    const t = setup();
    assert.throws(() => t.call('admin1', 'approve', { id: 42 }), { code: 'NO_PROPOSAL' });
    const { result: id } = t.call('admin1', 'propose', { change: t.set('max_rounds', 5) });
    t.call('admin2', 'approve', { id });
    assert.throws(() => t.call('admin3', 'approve', { id }), { code: 'NO_PROPOSAL' });
  });
});

describe('admin membership', () => {
  test('an admin can be added and then takes part', () => {
    const t = setup();
    const { result: id } = t.call('admin1', 'propose', { change: { type: 'AddAdmin', admin: t.a.fwd } });
    t.call('admin2', 'approve', { id });
    const { result: id2 } = t.call('fwd', 'propose', { change: t.set('max_rounds', 4) });
    t.call('admin3', 'approve', { id: id2 });
    assert.equal(t.setting('max_rounds'), 4);
  });
  test('adding an existing admin is BAD_SETTING', () => {
    const t = setup();
    assert.throws(() => t.call('admin1', 'propose', { change: { type: 'AddAdmin', admin: t.a.admin2 } }), { code: 'BAD_SETTING' });
  });
  test('removing below the quorum is BAD_SETTING', () => {
    const t = setup({ quorum: 3 });
    assert.throws(() => t.call('admin1', 'propose', { change: { type: 'RemoveAdmin', admin: t.a.admin3 } }), { code: 'BAD_SETTING' });
  });
  test('two removals that are each valid cannot together drop below the quorum', () => {
    const t = setup({ quorum: 2 });
    const { result: r1 } = t.call('admin1', 'propose', { change: { type: 'RemoveAdmin', admin: t.a.admin3 } });
    const { result: r2 } = t.call('admin1', 'propose', { change: { type: 'RemoveAdmin', admin: t.a.admin2 } });
    t.call('admin2', 'approve', { id: r1 }); // 2 admins left: still >= quorum
    assert.throws(() => t.call('admin2', 'approve', { id: r2 }), { code: 'BAD_SETTING' }); // would leave 1
  });
});

describe('quote registry', () => {
  test('new_quote creates a registered QuoteRequest for the caller', () => {
    const t = setup();
    const { result: q } = t.call('shipper', 'new_quote', { invited: [t.a.fwd], job: 'j', consignment: CONSIGNMENT, dispute: DISPUTE });
    assert.equal(t.chain.view(t.id, 'is_quote', { address: q }), true);
    assert.equal(t.chain.contractState(q).requester, t.a.shipper);
  });
  test('a QuoteRequest deployed directly is not registered', () => {
    const t = setup();
    const { result: q } = t.chain.deploy(QuoteRequest, t.a.shipper, { requester: t.a.shipper, invited: [t.a.fwd], job: 'j', consignment: CONSIGNMENT, dispute: DISPUTE, maxRounds: 3 });
    assert.equal(t.chain.view(t.id, 'is_quote', { address: q }), false);
  });
  test('quotes keep the round limit they were created with', () => {
    const t = setup();
    const { result: before } = t.call('shipper', 'new_quote', { invited: [t.a.fwd], job: 'j', consignment: CONSIGNMENT, dispute: DISPUTE });
    const { result: id } = t.call('admin1', 'propose', { change: t.set('max_rounds', 2) });
    t.call('admin2', 'approve', { id });
    const { result: after } = t.call('shipper', 'new_quote', { invited: [t.a.fwd], job: 'j', consignment: CONSIGNMENT, dispute: DISPUTE });
    assert.equal(t.chain.contractState(before).maxRounds, 3);
    assert.equal(t.chain.contractState(after).maxRounds, 2);
  });
  test('a panel larger than the max_panel setting is refused (BAD_QUORUM); at the limit is fine', () => {
    const t = setup();
    const panel = (n) => Array.from({ length: n }, (_, i) => `ak_demo_arbiter_${i}`);
    assert.throws(() => t.call('shipper', 'new_quote', { invited: [t.a.fwd], job: 'j', consignment: CONSIGNMENT, dispute: { ...DISPUTE, panel: panel(8) } }), { code: 'BAD_QUORUM' });
    assert.doesNotThrow(() => t.call('shipper', 'new_quote', { invited: [t.a.fwd], job: 'j', consignment: CONSIGNMENT, dispute: { ...DISPUTE, panel: panel(7) } }));
  });
  test('the platform never holds funds', () => {
    const t = setup();
    assert.throws(() => t.chain.call(t.id, 'new_quote', { invited: [t.a.fwd], job: 'j', consignment: CONSIGNMENT, dispute: DISPUTE }, { caller: t.a.shipper, value: 1n }), { code: 'NOT_PAYABLE' });
  });
});

describe('never holds funds (review #25)', () => {
  test('a Platform cannot be deployed with value (NOT_PAYABLE)', () => {
    const chain = new SimChain();
    const x = chain.createAccount('x', 10n);
    assert.throws(() => chain.deploy(Platform, x, { admins: [x], quorum: 1, treasury: 'ak_demo_treasury' }, { value: 1n }), { code: 'NOT_PAYABLE' });
  });
  test('a QuoteRequest cannot be deployed with value (NOT_PAYABLE)', () => {
    const chain = new SimChain();
    const x = chain.createAccount('x', 10n);
    const y = chain.createAccount('y', 0n);
    assert.throws(() => chain.deploy(QuoteRequest, x, { requester: x, invited: [y], job: 'j', consignment: CONSIGNMENT, dispute: DISPUTE, maxRounds: 3 }, { value: 1n }), { code: 'NOT_PAYABLE' });
  });
});
