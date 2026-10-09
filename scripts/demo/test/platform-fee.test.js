// Platform fee (ADR 0010): fixed when the quote is requested; skimmed from payouts to a main
// escrow's payee (never more than 10% of a payout); refunds and the shipper's share of a split
// pay none. Legs' payouts are fee-free, but their payer deposits a refundable bond.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain, codeHash } from '../lib/sim-chain.js';
import { escrowFor, feeDue, Status } from '../lib/shipment-escrow.js';
import { jobHash, termsHash } from '../lib/quote-request.js';
import { Platform, MAX_FEE_BPS } from '../lib/platform.js';
import { CONSIGNMENT } from '../lib/fixtures.js';

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

// Requests and agrees a quote for `price` between payer and payee (a leg of `parent` if given).
function agree(w, { payer = 'shipper', payee = 'forwarder', price, schedule = [], parent = null, deadlineIn = DEADLINE_IN }) {
  const { chain, a } = w;
  const args = { carrier: a[payee], consignee: a.consignee, attestors: [a.attestor], panel: [a.arbiter], quorum: 1, window: 2, fallback: 50n, manifest: 'm'.repeat(64), terms: { price, schedule }, deadline: chain.keyHeight + deadlineIn };
  const { result: quote } = chain.call(w.platform, 'new_quote', { invited: [a[payee]], job: jobHash(args), consignment: CONSIGNMENT, parent }, { caller: a[payer] });
  chain.call(quote, 'quote', { terms: termsHash(args.terms), validUntil: chain.keyHeight + 100 }, { caller: a[payee] });
  chain.call(quote, 'accept', { invitee: a[payee], terms: termsHash(args.terms) }, { caller: a[payer] });
  return { args, quote, payer };
}

// The bond a leg's payer must add: the fee at the quote's rate (ADR 0010).
const bondFor = (w, quote, price) => (w.chain.view(quote, 'parent') === null ? 0n : feeDue(w.chain.view(quote, 'fee_terms'), price));

function create(w, { args, quote, payer }, value = args.terms.price + bondFor(w, quote, args.terms.price)) {
  return w.chain.deploy(w.escrow, w.a[payer], { ...args, quote }, { value }).result;
}

const book = (w, opts) => create(w, agree(w, opts));
const leg = (w, parent, price, opts = {}) => book(w, { payer: 'forwarder', payee: 'carrier', price, parent, ...opts });

const call = (w, id, role, ep, args = {}) => w.chain.call(id, ep, args, { caller: w.a[role] });
const deliver = (w, id) => call(w, id, 'consignee', 'confirm_delivery', { evidence: H });
const feesPaid = (w, id) => w.chain.events(id).filter((e) => e.type === 'FeePaid').map((e) => e.amount);
const paidTo = (w, id, to) => w.chain.events(id).filter((e) => e.type === 'Paid' && e.to === to).reduce((s, e) => s + e.amount, 0n);

// Conservation, main or leg, at any point: what has left equals the agreed payouts plus any
// settled bond, the escrow holds the rest, and the fee is exactly what's due.
function assertConserved(w, id) {
  const s = w.chain.contractState(id);
  const settledBond = s.bondSettled ? s.bond : 0n;
  const paid = w.chain.events(id).filter((e) => e.type === 'Paid').reduce((sum, e) => sum + e.amount, 0n);
  assert.equal(paid, s.paidOut + settledBond, 'Paid events == payouts + settled bond');
  assert.equal(w.chain.balanceOf(id), s.amount - s.paidOut + (s.bond - settledBond), 'escrow holds the rest');
  assert.equal(s.feePaid, feeDue(s, s.toPayee), 'payee fee == fee due on the gross');
  if (s.status === Status.Released || s.status === Status.Refunded || s.status === Status.Resolved) {
    assert.equal(s.paidOut, s.amount, 'terminal: the whole price has been paid out');
  }
}

describe('feeDue', () => {
  const terms = { feeBps: 100, minFee: 50n };
  for (const [received, due, why] of [
    [0n, 0n, 'nothing received, nothing due'],
    [1n, 0n, 'the 10% cap rounds a tiny payout down to nothing'],
    [100n, 10n, 'the minimum is held to 10% of the payout'],
    [500n, 50n, 'exactly the minimum, which is also 10%'],
    [4_999n, 50n, 'the minimum beats 1% (49)'],
    [5_000n, 50n, '1% equals the minimum'],
    [5_100n, 51n, '1% beats the minimum'],
    [999_999n, 9_999n, '1% rounds down'],
  ]) {
    test(`${received} received → ${due} due (${why})`, () => assert.equal(feeDue(terms, received), due));
  }
  test('at the 10% rate cap the fee is exactly 10%', () => {
    assert.equal(feeDue({ feeBps: MAX_FEE_BPS, minFee: 0n }, 12_345n), 1_234n);
  });
  test('a zero rate and minimum is always 0', () => {
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
    assertConserved(w, id);
  });

  test('the minimum is taken from the first payout, and nothing more once 1% passes it', () => {
    const w = world({ min: 50n });
    const id = book(w, { price: 1_000n, schedule: [['A', 50]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [50n]);
    assert.equal(paidTo(w, id, w.a.forwarder), 950n);
    assertConserved(w, id);
  });

  test('a minimum above the price takes no more than 10% (review on #33)', () => {
    const w = world({ min: 500n });
    const id = book(w, { price: 300n });
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [30n]);
    assert.equal(paidTo(w, id, w.a.forwarder), 270n);
    assertConserved(w, id);
  });

  test('rounding over odd milestones lands on the last payout and totals exactly 1% (rounded down)', () => {
    const w = world();
    const id = book(w, { price: 999n, schedule: [['A', 33], ['B', 33]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'B', kind: 'ScanIn', evidence: H });
    deliver(w, id);
    assert.equal(feesPaid(w, id).reduce((s, f) => s + f, 0n), 9n);
    assertConserved(w, id);
  });

  test('a refund after the deadline pays no fee', () => {
    const w = world({ min: 50n });
    const id = book(w, { price: 1_000n });
    w.chain.advanceKeyblocks(DEADLINE_IN + 1);
    call(w, id, 'shipper', 'refund_after_deadline');
    assert.deepEqual(feesPaid(w, id), []);
    assert.equal(paidTo(w, id, w.a.shipper), 1_000n);
    assertConserved(w, id);
  });

  test('a refund after a milestone charges the fee only on the milestone', () => {
    const w = world();
    const id = book(w, { price: 10_000n, schedule: [['A', 40]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    w.chain.advanceKeyblocks(DEADLINE_IN + 1);
    call(w, id, 'shipper', 'refund_after_deadline');
    assert.deepEqual(feesPaid(w, id), [40n]);
    assert.equal(paidTo(w, id, w.a.shipper), 6_000n);
    assertConserved(w, id);
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
    assertConserved(w, id);
  });

  test('a split of 0% to the payee pays no fee, even with a minimum', () => {
    const w = world({ min: 50n });
    const id = book(w, { price: 1_000n });
    call(w, id, 'consignee', 'raise_dispute');
    call(w, id, 'arbiter', 'vote', { payCarrierPct: 0n });
    assert.deepEqual(feesPaid(w, id), []);
    assertConserved(w, id);
  });

  test('settle_bond on a main escrow has nothing to settle (NO_BOND)', () => {
    const w = world();
    const id = book(w, { price: 1_000n });
    deliver(w, id);
    assert.throws(() => call(w, id, 'shipper', 'settle_bond'), { code: 'NO_BOND' });
  });
});

describe('the fee is fixed when the quote is requested', () => {
  test('a vote during the negotiation does not change the fee or treasury at booking', () => {
    const w = world();
    const agreed = agree(w, { price: 10_000n });
    w.vote({ type: 'SetSetting', key: 'fee_bps', value: MAX_FEE_BPS });
    w.vote({ type: 'SetTreasury', treasury: 'ak_demo_new_treasury' });
    const id = create(w, agreed);
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [100n]);
    assert.equal(w.chain.balanceOf(TREASURY), 100n);
  });

  test('a quote requested after the vote uses the new rate and treasury', () => {
    const w = world();
    w.vote({ type: 'SetSetting', key: 'fee_bps', value: MAX_FEE_BPS });
    w.vote({ type: 'SetTreasury', treasury: 'ak_demo_new_treasury' });
    const id = book(w, { price: 10_000n });
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [1_000n]);
    assert.equal(w.chain.balanceOf('ak_demo_new_treasury'), 1_000n);
  });

  test('the quote shows its fee terms to both sides', () => {
    const w = world({ bps: 150, min: 7n });
    const { quote } = agree(w, { price: 1_000n });
    assert.deepEqual(w.chain.view(quote, 'fee_terms'), { feeBps: 150, minFee: 7n, treasury: TREASURY });
  });
});

describe('leg escrows and their bond', () => {
  function withParent(opts = {}, price = 10_000n) {
    const w = world(opts);
    const main = book(w, { price, deadlineIn: 50 });
    return { w, main };
  }

  test('a leg is funded with its price plus the fee as a bond, and pays its carrier in full', () => {
    const { w, main } = withParent();
    const id = leg(w, main, 4_000n);
    assert.equal(w.chain.balanceOf(id), 4_040n);
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), []);
    assert.equal(paidTo(w, id, w.a.carrier), 4_000n);
    assert.equal(w.chain.balanceOf(id), 40n, 'the bond waits for the parent');
    assertConserved(w, id);
  });

  test('rejects a leg funded without its bond (WRONG_AMOUNT)', () => {
    const { w, main } = withParent();
    const agreed = agree(w, { payer: 'forwarder', payee: 'carrier', price: 4_000n, parent: main });
    for (const value of [4_000n, 4_039n, 4_041n]) {
      assert.throws(() => create(w, agreed, value), { code: 'WRONG_AMOUNT' }, String(value));
    }
    assert.doesNotThrow(() => create(w, agreed, 4_040n));
  });

  test('the bond comes back in full once the parent is delivered', () => {
    const { w, main } = withParent();
    const id = leg(w, main, 4_000n);
    deliver(w, id);
    assert.throws(() => call(w, id, 'forwarder', 'settle_bond'), { code: 'PARENT_OPEN' });
    deliver(w, main);
    call(w, id, 'forwarder', 'settle_bond');
    assert.equal(paidTo(w, id, w.a.forwarder), 40n);
    assert.deepEqual(feesPaid(w, id), []);
    assertConserved(w, id);
  });

  test('a refunded parent forfeits the whole bond to the treasury (the bypass from review on #33)', () => {
    const { w, main } = withParent();
    const id = leg(w, main, 10_000n);
    deliver(w, id);
    w.chain.advanceKeyblocks(51);
    call(w, main, 'shipper', 'refund_after_deadline');
    call(w, id, 'forwarder', 'settle_bond');
    assert.deepEqual(feesPaid(w, id), [100n], 'exactly the fee the parent would have paid');
    assert.equal(paidTo(w, id, w.a.forwarder), 0n);
    assertConserved(w, id);
  });

  test('a split parent returns the bond in proportion to the payee’s share', () => {
    const { w, main } = withParent();
    const id = leg(w, main, 4_000n);
    call(w, main, 'consignee', 'raise_dispute');
    call(w, main, 'arbiter', 'vote', { payCarrierPct: 25n });
    call(w, id, 'forwarder', 'settle_bond');
    assert.equal(paidTo(w, id, w.a.forwarder), 10n);
    assert.deepEqual(feesPaid(w, id), [30n]);
    assertConserved(w, id);
  });

  test('the bond can be settled once the parent passes its deadline, so it can’t be frozen', () => {
    const { w, main } = withParent();
    const id = leg(w, main, 4_000n);
    w.chain.advanceKeyblocks(50);
    assert.throws(() => call(w, id, 'forwarder', 'settle_bond'), { code: 'PARENT_OPEN' }, 'at the deadline');
    w.chain.advanceKeyblocks(1);
    call(w, id, 'forwarder', 'settle_bond');
    assert.deepEqual(feesPaid(w, id), [40n], 'nothing paid to the parent payee yet');
    assertConserved(w, id);
  });

  test('only the leg’s payer settles its bond, and only once', () => {
    const { w, main } = withParent();
    const id = leg(w, main, 4_000n);
    deliver(w, main);
    for (const role of ['shipper', 'carrier', 'stranger']) {
      assert.throws(() => call(w, id, role, 'settle_bond'), { code: 'ONLY_SHIPPER' }, role);
    }
    call(w, id, 'forwarder', 'settle_bond');
    assert.throws(() => call(w, id, 'forwarder', 'settle_bond'), { code: 'BOND_SETTLED' });
  });

  test('a parent’s legs together can’t exceed its price (LEG_TOO_LARGE)', () => {
    const { w, main } = withParent();
    leg(w, main, 6_000n);
    assert.throws(() => leg(w, main, 4_001n), { code: 'LEG_TOO_LARGE' });
    assert.doesNotThrow(() => leg(w, main, 4_000n));
    assert.throws(() => leg(w, main, 1n), { code: 'LEG_TOO_LARGE' }, 'the cap is the total, not per leg');
  });

  test('a leg can’t be the parent of another leg (NOT_MAIN)', () => {
    const { w, main } = withParent();
    const id = leg(w, main, 4_000n);
    assert.throws(() => call(w, w.platform, 'carrier', 'new_quote', { invited: [w.a.stranger], job: H, consignment: CONSIGNMENT, parent: id }), { code: 'NOT_MAIN' });
  });

  test('only the parent’s payee can open a leg quote (NOT_PAYEE)', () => {
    const { w, main } = withParent();
    for (const role of ['shipper', 'carrier', 'stranger']) {
      assert.throws(() => call(w, w.platform, role, 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, parent: main }), { code: 'NOT_PAYEE' }, role);
    }
  });

  test('a settled parent can’t take new legs (BAD_STATE)', () => {
    const { w, main } = withParent();
    deliver(w, main);
    assert.throws(() => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, parent: main }), { code: 'BAD_STATE' });
  });

  test('the parent must be a genuine escrow (UNKNOWN_ESCROW)', () => {
    const { w, main } = withParent();
    const legQuote = (parent) => () => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, parent });
    assert.throws(legQuote(w.a.stranger), { code: 'UNKNOWN_ESCROW' }, 'a plain account');
    assert.throws(legQuote(w.platform), { code: 'UNKNOWN_ESCROW' }, 'another kind of contract');
    // An escrow template bound to a different platform has a different bytecode hash.
    const { result: p2 } = w.chain.deploy(Platform, w.a.admin1, { admins: [w.a.admin1], quorum: 1, treasury: TREASURY });
    const foreign = book({ ...w, platform: p2, escrow: escrowFor(p2) }, { price: 10_000n });
    assert.throws(legQuote(foreign), { code: 'UNKNOWN_ESCROW' }, 'another platform’s escrow');
    assert.doesNotThrow(legQuote(main));
  });

  test('a look-alike escrow with the same name and platform but different code is not genuine (review on #34)', () => {
    const { w } = withParent();
    const lookAlike = { ...w.escrow, views: { ...w.escrow.views, is_leg: () => false, is_open: () => true } };
    const { args, quote } = agree(w, { price: 10_000n });
    const fake = w.chain.deploy(lookAlike, w.a.shipper, { ...args, quote }, { value: 10_000n }).result;
    assert.notEqual(codeHash(lookAlike), codeHash(w.escrow));
    assert.throws(() => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, parent: fake }), { code: 'UNKNOWN_ESCROW' });
  });

  test('only the escrow template can register a leg (UNKNOWN_ESCROW)', () => {
    const { w, main } = withParent();
    assert.throws(() => call(w, w.platform, 'forwarder', 'add_leg', { parent: main, price: 1n }), { code: 'UNKNOWN_ESCROW' });
  });

  test('no legs until the admins have voted in the escrow template (UNKNOWN_ESCROW)', () => {
    const chain = new SimChain();
    const admin = chain.createAccount('admin', 1_000_000n);
    const { result: platform } = chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury: TREASURY });
    assert.throws(() => chain.call(platform, 'new_quote', { invited: ['ak_demo_x'], job: H, consignment: CONSIGNMENT, parent: platform }, { caller: admin }), { code: 'UNKNOWN_ESCROW' });
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

test('property: random parent and leg histories conserve funds, bonds included (seeded)', () => {
  const seed = 0x0b0d;
  let x = seed;
  const rand = (n) => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x % n);
  for (let run = 0; run < 200; run++) {
    const w = world({ bps: [0, 100, 250, MAX_FEE_BPS][rand(4)], min: [0n, 7n, 500n][rand(3)] });
    const supply = w.chain.totalSupply();
    const main = book(w, { price: 10_000n, schedule: [['A', 30]], deadlineIn: 20 });
    const legs = [leg(w, main, BigInt(1 + rand(5_000))), leg(w, main, BigInt(1 + rand(5_000)))];
    const actions = [
      () => call(w, main, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H }),
      () => deliver(w, main),
      () => call(w, main, 'consignee', 'raise_dispute'),
      () => call(w, main, 'arbiter', 'vote', { payCarrierPct: BigInt(rand(101)) }),
      () => call(w, main, 'shipper', 'refund_after_deadline'),
      () => deliver(w, legs[rand(2)]),
      () => call(w, legs[rand(2)], 'forwarder', 'settle_bond'),
      () => w.chain.advanceKeyblocks(rand(15)),
    ];
    for (let i = 0; i < 14; i++) {
      try {
        actions[rand(actions.length)]();
      } catch (e) {
        assert.ok(e.code, `seed=${seed} run=${run}: non-contract error ${e}`);
      }
      for (const id of [main, ...legs]) assertConserved(w, id);
      assert.equal(w.chain.totalSupply(), supply, `seed=${seed} run=${run}: supply changed`);
    }
  }
});
