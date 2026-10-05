// Platform fee (ADR 0010): skimmed from payouts to a main escrow's payee, at the rate the
// escrow was created with; legs, refunds and the shipper's share of a split pay none.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain, codeHash } from '../lib/sim-chain.js';
import { escrowFor, feeDue, Status } from '../lib/shipment-escrow.js';
import { jobHash, termsHash } from '../lib/quote-request.js';
import { Platform, MAX_FEE_BPS } from '../lib/platform.js';

const H = 'a'.repeat(64);
const DEADLINE_IN = 10;
const TREASURY = 'ak_demo_treasury';
const ROLES = ['admin1', 'admin2', 'admin3', 'shipper', 'forwarder', 'carrier', 'consignee', 'attestor', 'arbiter', 'stranger'];

// A platform with 3 admins (quorum as given), the fee as given, and the escrow template voted in.
function world({ bps = 100, min = 0n, quorum = 1 } = {}) {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 1_000_000n)]));
  const { result: platform } = chain.deploy(Platform, a.admin1, { admins: [a.admin1, a.admin2, a.admin3], quorum, treasury: TREASURY });
  const escrow = escrowFor(platform);
  const w = { chain, a, platform, escrow };
  w.vote = (change) => {
    const { result: id } = chain.call(platform, 'propose', { change }, { caller: a.admin1 });
    if (quorum > 1) chain.call(platform, 'approve', { id }, { caller: a.admin2 });
  };
  w.vote({ type: 'SetSetting', key: 'fee_bps', value: bps });
  w.vote({ type: 'SetSetting', key: 'min_fee', value: min });
  w.vote({ type: 'SetEscrowCode', hash: codeHash(escrow) });
  return w;
}

// Agrees `price` between payer and payee (as a leg of `parent` if given) and books the escrow.
function book(w, { payer = 'shipper', payee = 'forwarder', price, schedule = [], parent = null }) {
  const { chain, a } = w;
  const args = { carrier: a[payee], consignee: a.consignee, attestors: [a.attestor], panel: [a.arbiter], quorum: 1, window: 2, fallback: 50n, manifest: 'm'.repeat(64), terms: { price, schedule }, deadline: chain.keyHeight + DEADLINE_IN };
  const { result: quote } = chain.call(w.platform, 'new_quote', { invited: [a[payee]], job: jobHash(args), parent }, { caller: a[payer] });
  chain.call(quote, 'propose', { invitee: a[payee], terms: termsHash(args.terms), validUntil: chain.keyHeight + 100 }, { caller: a[payee] });
  chain.call(quote, 'accept', { invitee: a[payee], terms: termsHash(args.terms) }, { caller: a[payer] });
  const { result: id } = chain.deploy(w.escrow, a[payer], { ...args, quote }, { value: price });
  return id;
}

const call = (w, id, role, ep, args = {}) => w.chain.call(id, ep, args, { caller: w.a[role] });
const deliver = (w, id) => call(w, id, 'consignee', 'confirm_delivery', { evidence: H });
const feesPaid = (w, id) => w.chain.events(id).filter((e) => e.type === 'FeePaid').map((e) => e.amount);
const paidTo = (w, id, to) => w.chain.events(id).filter((e) => e.type === 'Paid' && e.to === to).reduce((s, e) => s + e.amount, 0n);

// Every terminal escrow pays out exactly what it was funded with: payee, treasury and shipper.
function assertSettled(w, id, price) {
  const { a, chain } = w;
  const total = paidTo(w, id, a.forwarder) + paidTo(w, id, a.carrier) + paidTo(w, id, TREASURY) + paidTo(w, id, a.shipper);
  assert.equal(total, price, 'payee + treasury + shipper == funded');
  assert.equal(chain.balanceOf(id), 0n, 'escrow empty');
}

describe('feeDue', () => {
  const terms = { feeBps: 100, minFee: 50n };
  for (const [received, due, why] of [
    [0n, 0n, 'nothing received, nothing due'],
    [1n, 1n, 'the minimum is capped at what was received'],
    [50n, 50n, 'exactly the minimum'],
    [4_999n, 50n, 'the minimum beats 1% (49)'],
    [5_000n, 50n, '1% equals the minimum'],
    [5_100n, 51n, '1% beats the minimum'],
    [999_999n, 9_999n, '1% rounds down'],
  ]) {
    test(`${received} received → ${due} due (${why})`, () => assert.equal(feeDue(terms, received), due));
  }
  test('a zero rate and minimum (a leg) is always 0', () => {
    assert.equal(feeDue({ feeBps: 0, minFee: 0n }, 10n ** 24n), 0n);
  });
});

describe('main escrow', () => {
  test('each milestone and the delivery pay 1% to the treasury, the rest to the payee', () => {
    const w = world();
    const id = book(w, { price: 10_000n, schedule: [['A', 20], ['B', 30]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'B', kind: 'ScanIn', evidence: H });
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [20n, 30n, 50n]);
    assert.equal(paidTo(w, id, w.a.forwarder), 9_900n);
    assert.equal(w.chain.balanceOf(TREASURY), 100n);
    assertSettled(w, id, 10_000n);
  });

  test('the minimum is taken from the first payout, and nothing more once 1% passes it', () => {
    const w = world({ min: 50n });
    const id = book(w, { price: 1_000n, schedule: [['A', 20]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [50n]);
    assert.equal(paidTo(w, id, w.a.forwarder), 950n);
    assertSettled(w, id, 1_000n);
  });

  test('the fee never exceeds what the payee received (minimum above the price)', () => {
    const w = world({ min: 500n });
    const id = book(w, { price: 300n });
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [300n]);
    assert.equal(paidTo(w, id, w.a.forwarder), 0n);
    assertSettled(w, id, 300n);
  });

  test('rounding over odd milestones lands on the last payout and totals exactly 1% (rounded down)', () => {
    const w = world();
    const id = book(w, { price: 999n, schedule: [['A', 33], ['B', 33]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'B', kind: 'ScanIn', evidence: H });
    deliver(w, id);
    assert.equal(feesPaid(w, id).reduce((s, f) => s + f, 0n), 9n);
    assertSettled(w, id, 999n);
  });

  test('a refund after the deadline pays no fee', () => {
    const w = world({ min: 50n });
    const id = book(w, { price: 1_000n });
    w.chain.advanceKeyblocks(DEADLINE_IN + 1);
    call(w, id, 'shipper', 'refund_after_deadline');
    assert.deepEqual(feesPaid(w, id), []);
    assert.equal(paidTo(w, id, w.a.shipper), 1_000n);
    assertSettled(w, id, 1_000n);
  });

  test('a refund after a milestone charges the fee only on the milestone', () => {
    const w = world();
    const id = book(w, { price: 10_000n, schedule: [['A', 40]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    w.chain.advanceKeyblocks(DEADLINE_IN + 1);
    call(w, id, 'shipper', 'refund_after_deadline');
    assert.deepEqual(feesPaid(w, id), [40n]);
    assert.equal(paidTo(w, id, w.a.shipper), 6_000n);
    assertSettled(w, id, 10_000n);
  });

  test('a dispute split charges only the payee’s share', () => {
    const w = world();
    const id = book(w, { price: 10_000n });
    call(w, id, 'consignee', 'raise_dispute');
    call(w, id, 'arbiter', 'vote', { payCarrierPct: 30n });
    assert.equal(w.chain.contractState(id).status, Status.Resolved);
    assert.deepEqual(feesPaid(w, id), [30n]);
    assert.equal(paidTo(w, id, w.a.forwarder), 2_970n);
    assert.equal(paidTo(w, id, w.a.shipper), 7_000n);
    assertSettled(w, id, 10_000n);
  });

  test('a split of 0% to the payee pays no fee, even with a minimum', () => {
    const w = world({ min: 50n });
    const id = book(w, { price: 1_000n });
    call(w, id, 'consignee', 'raise_dispute');
    call(w, id, 'arbiter', 'vote', { payCarrierPct: 0n });
    assert.deepEqual(feesPaid(w, id), []);
    assertSettled(w, id, 1_000n);
  });

  test('a vote after booking does not change a live escrow’s fee or treasury', () => {
    const w = world();
    const id = book(w, { price: 10_000n });
    w.vote({ type: 'SetSetting', key: 'fee_bps', value: MAX_FEE_BPS });
    w.vote({ type: 'SetTreasury', treasury: 'ak_demo_new_treasury' });
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [100n]);
    assert.equal(w.chain.balanceOf(TREASURY), 100n);
    const later = book(w, { price: 10_000n });
    deliver(w, later);
    assert.deepEqual(feesPaid(w, later), [1_000n], 'a new escrow uses the new rate');
    assert.equal(w.chain.balanceOf('ak_demo_new_treasury'), 1_000n, 'and the new treasury');
  });
});

describe('leg escrows', () => {
  function withParent(opts) {
    const w = world(opts);
    const main = book(w, { price: 10_000n });
    return { w, main };
  }

  test('a leg named from its parent pays no fee', () => {
    const { w, main } = withParent({ min: 50n });
    const leg = book(w, { payer: 'forwarder', payee: 'carrier', price: 4_000n, parent: main });
    deliver(w, leg);
    assert.deepEqual(feesPaid(w, leg), []);
    assert.equal(paidTo(w, leg, w.a.carrier), 4_000n);
    assertSettled(w, leg, 4_000n);
  });

  test('a leg may cost as much as its parent, not more (LEG_TOO_LARGE)', () => {
    const { w, main } = withParent();
    assert.doesNotThrow(() => book(w, { payer: 'forwarder', payee: 'carrier', price: 10_000n, parent: main }));
    assert.throws(() => book(w, { payer: 'forwarder', payee: 'carrier', price: 10_001n, parent: main }), { code: 'LEG_TOO_LARGE' });
  });

  test('only the parent’s payee can open a leg quote (NOT_PAYEE)', () => {
    const { w, main } = withParent();
    for (const role of ['shipper', 'carrier', 'stranger']) {
      assert.throws(() => call(w, w.platform, role, 'new_quote', { invited: [w.a.carrier], job: H, parent: main }), { code: 'NOT_PAYEE' }, role);
    }
  });

  test('a settled parent can’t take new legs (BAD_STATE)', () => {
    const { w, main } = withParent();
    deliver(w, main);
    assert.throws(() => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, parent: main }), { code: 'BAD_STATE' });
  });

  test('the parent must be a genuine escrow (UNKNOWN_ESCROW)', () => {
    const { w, main } = withParent();
    const leg = (parent) => () => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, parent });
    assert.throws(leg(w.a.stranger), { code: 'UNKNOWN_ESCROW' }, 'a plain account');
    assert.throws(leg(w.platform), { code: 'UNKNOWN_ESCROW' }, 'another kind of contract');
    // An escrow template bound to a different platform has a different bytecode hash.
    const { result: p2 } = w.chain.deploy(Platform, w.a.admin1, { admins: [w.a.admin1], quorum: 1, treasury: TREASURY });
    const foreign = book({ ...w, platform: p2, escrow: escrowFor(p2) }, { price: 10_000n });
    assert.throws(leg(foreign), { code: 'UNKNOWN_ESCROW' }, 'another platform’s escrow');
    assert.doesNotThrow(leg(main));
  });

  test('no legs until the admins have voted in the escrow template (UNKNOWN_ESCROW)', () => {
    const chain = new SimChain();
    const admin = chain.createAccount('admin', 1_000_000n);
    const { result: platform } = chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury: TREASURY });
    assert.throws(() => chain.call(platform, 'new_quote', { invited: ['ak_demo_x'], job: H, parent: platform }, { caller: admin }), { code: 'UNKNOWN_ESCROW' });
  });
});

describe('fee settings are voted like the others', () => {
  test('fee_bps accepts 0 and the 10% cap, and rejects values outside or not whole (BAD_SETTING)', () => {
    const w = world();
    for (const value of [0, MAX_FEE_BPS]) assert.doesNotThrow(() => w.vote({ type: 'SetSetting', key: 'fee_bps', value }));
    for (const value of [-1, MAX_FEE_BPS + 1, 1.5, 100n]) {
      assert.throws(() => w.vote({ type: 'SetSetting', key: 'fee_bps', value }), { code: 'BAD_SETTING' }, String(value));
    }
  });

  test('min_fee accepts 0 and any bigint amount, and rejects negatives and numbers (BAD_SETTING)', () => {
    const w = world();
    for (const value of [0n, 10n ** 24n]) assert.doesNotThrow(() => w.vote({ type: 'SetSetting', key: 'min_fee', value }));
    for (const value of [-1n, 5]) assert.throws(() => w.vote({ type: 'SetSetting', key: 'min_fee', value }), { code: 'BAD_SETTING' }, String(value));
  });

  test('the treasury changes only on a quorum of admins', () => {
    const w = world({ quorum: 2 });
    const change = { type: 'SetTreasury', treasury: 'ak_demo_new_treasury' };
    assert.throws(() => call(w, w.platform, 'stranger', 'propose', { change }), { code: 'ONLY_ADMIN' });
    const { result: id } = call(w, w.platform, 'admin1', 'propose', { change });
    assert.equal(w.chain.view(w.platform, 'treasury'), TREASURY, 'one approval is not enough');
    call(w, w.platform, 'admin2', 'approve', { id });
    assert.equal(w.chain.view(w.platform, 'treasury'), 'ak_demo_new_treasury');
  });

  test('rejects an empty treasury or escrow hash (BAD_SETTING)', () => {
    const w = world();
    assert.throws(() => w.vote({ type: 'SetTreasury', treasury: '' }), { code: 'BAD_SETTING' });
    assert.throws(() => w.vote({ type: 'SetEscrowCode', hash: '' }), { code: 'BAD_SETTING' });
  });

  test('a platform needs a treasury (BAD_TREASURY)', () => {
    const chain = new SimChain();
    const admin = chain.createAccount('admin', 0n);
    for (const treasury of [undefined, '']) {
      assert.throws(() => chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury }), { code: 'BAD_TREASURY' });
    }
  });

  test('starts at 1% with a 1 Gaju minimum', () => {
    const chain = new SimChain();
    const admin = chain.createAccount('admin', 0n);
    const { result: p } = chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury: TREASURY });
    assert.equal(chain.view(p, 'setting', { key: 'fee_bps' }), 100);
    assert.equal(chain.view(p, 'setting', { key: 'min_fee' }), 10n ** 18n);
  });
});
