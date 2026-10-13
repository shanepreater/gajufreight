// Platform fee and confirmation bond (ADR 0018, superseding ADR 0010 decisions 1 and 5). The
// payee confirms a booking by staking max(fee, bond_bps × price); the fee goes to the treasury
// at once and the rest is held until the escrow ends: back to the payee on release, to the
// payer on a refund, split by the ruling on a dispute. Legs carry no fee. Rates are fixed when
// the quote is requested.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { escrowFor, installTemplates, feeDue, bondFor, Status } from '../lib/shipment-escrow.js';
import { jobHash, termsHash, quoteTerms } from '../lib/quote-request.js';
import { Platform, MAX_FEE_BPS } from '../lib/platform.js';
import { CONSIGNMENT } from '../lib/fixtures.js';
import { verifyArbiters, installFor } from './support.js';

const DISPUTE = { panel: ['ak_demo_arbiter'], quorum: 1, window: 2, fallback: 50, challenge: 1 };

const H = 'a'.repeat(64);
const DEADLINE_IN = 10;
const CONFIRM_WINDOW = 5;
const TREASURY = 'ak_demo_treasury';
const ROLES = ['admin1', 'admin2', 'admin3', 'shipper', 'forwarder', 'carrier', 'consignee', 'attestor', 'arbiter', 'stranger'];

// A platform with 3 admins (quorum as given), the fee and bond rate as given, and its templates
// voted in.
function world({ bps = 100, min = 0n, bondBps = 0, quorum = 1 } = {}) {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 1_000_000n)]));
  const { result: platform } = chain.deploy(Platform, a.admin1, { admins: [a.admin1, a.admin2, a.admin3], quorum, treasury: TREASURY });
  const w = { chain, a, platform };
  w.vote = (change) => {
    const { result: id } = chain.call(platform, 'propose', { change }, { caller: a.admin1 });
    if (quorum > 1) chain.call(platform, 'approve', { id }, { caller: a.admin2 });
  };
  w.vote({ type: 'SetSetting', key: 'fee_bps', value: bps });
  w.vote({ type: 'SetSetting', key: 'min_fee', value: min });
  w.vote({ type: 'SetSetting', key: 'bond_bps', value: bondBps });
  w.vote({ type: 'SetSetting', key: 'confirm_window', value: CONFIRM_WINDOW });
  w.vote({ type: 'SetSetting', key: 'arbiter_fee_bps', value: 0 }); // disputes here need no deposit
  w.vote({ type: 'SetSetting', key: 'min_arbiter_fee', value: 0n });
  verifyArbiters(chain, platform, a.admin1, [a.arbiter, 'ak_demo_arbiter'], w.vote);
  installTemplates(chain, platform, a.admin1, w.vote);
  return w;
}

// Requests and agrees a quote for `price` between payer and payee (a leg of `parent` if given).
function agree(w, { payer = 'shipper', payee = 'forwarder', price, schedule = [], parent = null, deadlineIn = DEADLINE_IN }) {
  const { chain, a } = w;
  const deadline = chain.keyHeight + deadlineIn;
  // The full terms carry the request's dispute terms and the deadline (ADR 0011, ADR 0015).
  const dispute = { panel: [a.arbiter], quorum: 1, window: 2, fallback: 50, challenge: 1 };
  const args = { carrier: a[payee], consignee: a.consignee, attestors: [a.attestor], panel: dispute.panel, quorum: 1, window: 2, fallback: 50n, manifest: 'm'.repeat(64), terms: { price, schedule, attestors: [a.attestor], deadline, ...dispute }, deadline };
  const { result: quote } = chain.call(w.platform, 'new_quote', { invited: [a[payee]], job: jobHash(args), consignment: CONSIGNMENT, dispute, parent }, { caller: a[payer] });
  chain.call(quote, 'quote', { terms: args.terms, validUntil: chain.keyHeight + 100 }, { caller: a[payee] });
  chain.call(quote, 'accept', { invitee: a[payee], terms: termsHash(quoteTerms(args.terms)) }, { caller: a[payer] });
  return { args, quote, payer, payee };
}

// Books (the payer funds exactly the price), leaving the escrow Unconfirmed.
function create(w, { args, quote, payer }, value = args.terms.price) {
  return w.chain.call(w.platform, 'book', { quote, manifest: args.manifest, consignee: args.consignee }, { caller: w.a[payer], value }).result;
}

const requiredBond = (w, id) => w.chain.contractState(id).bond;
const call = (w, id, role, ep, args = {}, value = 0n) => w.chain.call(id, ep, args, { caller: w.a[role], value });
const confirm = (w, id, role, value = requiredBond(w, id)) => call(w, id, role, 'confirm', {}, value);

// Books and confirms, as the demo does unless a test wants the Unconfirmed state.
function book(w, opts) {
  const agreed = agree(w, opts);
  const id = create(w, agreed);
  confirm(w, id, agreed.payee);
  return id;
}
const leg = (w, parent, price, opts = {}) => book(w, { payer: 'forwarder', payee: 'carrier', price, parent, ...opts });

const deliver = (w, id) => call(w, id, 'consignee', 'confirm_delivery', { evidence: H });
const feesPaid = (w, id) => w.chain.events(id).filter((e) => e.type === 'FeePaid').map((e) => e.amount);
const paidTo = (w, id, to) => w.chain.events(id).filter((e) => e.type === 'Paid' && e.to === to).reduce((s, e) => s + e.amount, 0n);
const isTerminal = (s) => [Status.Released, Status.Refunded, Status.Resolved].includes(s.status);

// Conservation at any point: everything that left equals the price paid out plus the bond paid
// out, the escrow holds the rest, and once terminal it holds nothing.
function assertConserved(w, id) {
  const s = w.chain.contractState(id);
  const staked = w.chain.events(id).some((e) => e.type === 'Confirmed') ? s.bond : 0n;
  const paid = w.chain.events(id).filter((e) => e.type === 'Paid').reduce((sum, e) => sum + e.amount, 0n);
  assert.equal(paid, s.paidOut + s.bondOut, 'Paid events == price paid out + bond paid out');
  assert.equal(w.chain.balanceOf(id), s.amount - s.paidOut + staked - s.bondOut, 'escrow holds the rest');
  if (isTerminal(s)) {
    assert.equal(w.chain.balanceOf(id), 0n, 'terminal: nothing left');
    assert.equal(s.paidOut, s.amount, 'terminal: the whole price has been paid out');
  }
}

describe('feeDue (on the price)', () => {
  const terms = { feeBps: 100, minFee: 50n };
  for (const [price, due, why] of [
    [1n, 0n, 'the 10% cap rounds a tiny price down to nothing'],
    [100n, 10n, 'the minimum is held to 10% of the price'],
    [500n, 50n, 'exactly the minimum, which is also 10%'],
    [4_999n, 50n, 'the minimum beats 1% (49)'],
    [5_000n, 50n, '1% equals the minimum'],
    [5_100n, 51n, '1% beats the minimum'],
    [999_999n, 9_999n, '1% rounds down'],
  ]) {
    test(`${price} → ${due} (${why})`, () => assert.equal(feeDue(terms, price), due));
  }
  test('at the 10% rate cap the fee is exactly 10%', () => {
    assert.equal(feeDue({ feeBps: MAX_FEE_BPS, minFee: 0n }, 12_345n), 1_234n);
  });
  test('the owner’s examples: 1,000 → 10, 50 → 1 (minimum), 5 → 0.5 (10% wins), in tenths', () => {
    const gaju = { feeBps: 100, minFee: 10n };
    assert.deepEqual([10_000n, 500n, 50n].map((p) => feeDue(gaju, p)), [100n, 10n, 5n]);
  });
});

describe('bondFor', () => {
  test('is the fee while bond_bps is 0', () => assert.equal(bondFor({ feeBps: 100, minFee: 0n, bondBps: 0 }, 10_000n), 100n));
  test('is bond_bps of the price when that is larger', () => assert.equal(bondFor({ feeBps: 100, minFee: 0n, bondBps: 500 }, 10_000n), 500n));
  test('is the fee when that is larger', () => assert.equal(bondFor({ feeBps: 300, minFee: 0n, bondBps: 1 }, 10_000n), 300n));
  test('a leg’s fee terms are 0, so its bond is bond_bps alone', () => {
    assert.equal(bondFor({ feeBps: 0, minFee: 0n, bondBps: 0 }, 10_000n), 0n);
    assert.equal(bondFor({ feeBps: 0, minFee: 0n, bondBps: 200 }, 10_000n), 200n);
  });
  test('never more than 10% of the price', () => assert.equal(bondFor({ feeBps: MAX_FEE_BPS, minFee: 10n ** 9n, bondBps: MAX_FEE_BPS }, 999n), 99n));
});

describe('booking and confirming', () => {
  test('a booking is funded with exactly the price and starts Unconfirmed, holding no bond', () => {
    const w = world();
    const agreed = agree(w, { price: 10_000n });
    for (const value of [9_999n, 10_100n]) assert.throws(() => create(w, agreed, value), { code: 'WRONG_AMOUNT' }, String(value));
    const id = create(w, agreed);
    assert.equal(w.chain.contractState(id).status, Status.Unconfirmed);
    assert.equal(w.chain.balanceOf(id), 10_000n);
    assertConserved(w, id);
  });

  test('confirming stakes the bond, pays the fee to the treasury at once, and moves to Funded', () => {
    const w = world({ bondBps: 300 });
    const id = create(w, agree(w, { price: 10_000n }));
    confirm(w, id, 'forwarder', 300n);
    const s = w.chain.contractState(id);
    assert.equal(s.status, Status.Funded);
    assert.deepEqual(feesPaid(w, id), [100n]);
    assert.equal(w.chain.balanceOf(TREASURY), 100n);
    assert.equal(w.chain.balanceOf(id), 10_200n, 'price plus the held part of the bond');
    assertConserved(w, id);
  });

  test('only the payee confirms (ONLY_PAYEE)', () => {
    const w = world();
    const id = create(w, agree(w, { price: 10_000n }));
    for (const role of ['shipper', 'carrier', 'attestor', 'stranger']) {
      assert.throws(() => confirm(w, id, role, 100n), { code: 'ONLY_PAYEE' }, role);
    }
  });

  test('confirm needs exactly the bond (WRONG_AMOUNT)', () => {
    const w = world();
    const id = create(w, agree(w, { price: 10_000n }));
    for (const value of [0n, 99n, 101n]) assert.throws(() => confirm(w, id, 'forwarder', value), { code: 'WRONG_AMOUNT' }, String(value));
    assert.doesNotThrow(() => confirm(w, id, 'forwarder', 100n));
  });

  test('confirm works up to confirm_by and not after (CONFIRM_EXPIRED)', () => {
    const w = world();
    const late = create(w, agree(w, { price: 10_000n }));
    const onTime = create(w, agree(w, { price: 10_000n }));
    w.chain.advanceKeyblocks(CONFIRM_WINDOW);
    assert.doesNotThrow(() => confirm(w, onTime, 'forwarder'), 'at confirm_by');
    w.chain.advanceKeyblocks(1);
    assert.throws(() => confirm(w, late, 'forwarder'), { code: 'CONFIRM_EXPIRED' }, 'one block after');
  });

  test('confirm only once (BAD_STATE)', () => {
    const w = world();
    const id = book(w, { price: 10_000n });
    assert.throws(() => confirm(w, id, 'forwarder', 100n), { code: 'BAD_STATE' });
  });

  test('while Unconfirmed nothing else moves: no checkpoint, delivery, dispute or refund (BAD_STATE)', () => {
    const w = world();
    const id = create(w, agree(w, { price: 10_000n }));
    assert.throws(() => call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H }), { code: 'BAD_STATE' });
    assert.throws(() => deliver(w, id), { code: 'BAD_STATE' });
    assert.throws(() => call(w, id, 'shipper', 'raise_dispute'), { code: 'BAD_STATE' });
    w.chain.advanceKeyblocks(DEADLINE_IN + 1);
    assert.throws(() => call(w, id, 'shipper', 'refund_after_deadline'), { code: 'BAD_STATE' });
  });

  test('an Unconfirmed main escrow can’t take legs yet (BAD_STATE)', () => {
    const w = world();
    const main = create(w, agree(w, { price: 10_000n }));
    assert.throws(() => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, dispute: DISPUTE, parent: main }), { code: 'BAD_STATE' });
  });
});

describe('cancelling an unconfirmed booking', () => {
  for (const role of ['shipper', 'forwarder']) {
    test(`the ${role === 'shipper' ? 'payer' : 'payee'} can cancel: full refund, no fee`, () => {
      const w = world({ min: 50n });
      const id = create(w, agree(w, { price: 10_000n }));
      call(w, id, role, 'cancel_booking');
      assert.equal(w.chain.contractState(id).status, Status.Refunded);
      assert.equal(paidTo(w, id, w.a.shipper), 10_000n);
      assert.deepEqual(feesPaid(w, id), []);
      assert.ok(w.chain.events(id).some((e) => e.type === 'Cancelled' && e.by === w.a[role]));
      assertConserved(w, id);
    });
  }

  test('the payer can cancel after confirm_by too, so funds are never stuck', () => {
    const w = world();
    const id = create(w, agree(w, { price: 10_000n }));
    w.chain.advanceKeyblocks(CONFIRM_WINDOW + 100);
    call(w, id, 'shipper', 'cancel_booking');
    assertConserved(w, id);
  });

  test('nobody else can cancel (UNAUTHORIZED)', () => {
    const w = world();
    const id = create(w, agree(w, { price: 10_000n }));
    for (const role of ['consignee', 'attestor', 'arbiter', 'stranger']) {
      assert.throws(() => call(w, id, role, 'cancel_booking'), { code: 'UNAUTHORIZED' }, role);
    }
  });

  test('no cancelling once confirmed (BAD_STATE)', () => {
    const w = world();
    const id = book(w, { price: 10_000n });
    assert.throws(() => call(w, id, 'shipper', 'cancel_booking'), { code: 'BAD_STATE' });
  });
});

describe('main escrow: the fee is always paid, by the payee', () => {
  test('milestones and delivery pay the payee in full; the fee was taken at confirmation', () => {
    const w = world();
    const id = book(w, { price: 10_000n, schedule: [['A', 20], ['B', 30]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'B', kind: 'ScanIn', evidence: H });
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), [100n]);
    assert.equal(paidTo(w, id, w.a.forwarder), 10_000n);
    assert.equal(w.chain.balanceOf(TREASURY), 100n);
    assertConserved(w, id);
  });

  test('a minimum above 10% of the price takes only 10% (the 5 木 example)', () => {
    const w = world({ min: 500n });
    const id = book(w, { price: 300n });
    assert.deepEqual(feesPaid(w, id), [30n]);
    deliver(w, id);
    assertConserved(w, id);
  });

  test('a refund after the deadline still collects the fee, from the payee', () => {
    const w = world({ min: 50n });
    const id = book(w, { price: 1_000n });
    w.chain.advanceKeyblocks(DEADLINE_IN + 1);
    call(w, id, 'shipper', 'refund_after_deadline');
    assert.deepEqual(feesPaid(w, id), [50n]);
    assert.equal(paidTo(w, id, w.a.shipper), 1_000n, 'the payer gets the whole price back');
    assertConserved(w, id);
  });

  test('a dispute split still collects the fee, and the payer’s share is untouched', () => {
    const w = world();
    const id = book(w, { price: 10_000n });
    call(w, id, 'shipper', 'raise_dispute');
    call(w, id, 'arbiter', 'vote', { payCarrierPct: 30n });
    assert.equal(w.chain.contractState(id).status, Status.Resolved);
    assert.deepEqual(feesPaid(w, id), [100n]);
    assert.equal(paidTo(w, id, w.a.forwarder), 3_000n);
    assert.equal(paidTo(w, id, w.a.shipper), 7_000n);
    assertConserved(w, id);
  });
});

describe('the held bond (bond_bps above the fee)', () => {
  // Bond 500 on 10,000: fee 100 to the treasury at confirmation, 400 held.
  const held = () => {
    const w = world({ bondBps: 500 });
    return { w, id: book(w, { price: 10_000n, deadlineIn: 20 }) };
  };

  test('delivered: the held part goes back to the payee', () => {
    const { w, id } = held();
    deliver(w, id);
    assert.equal(paidTo(w, id, w.a.forwarder), 10_400n);
    assertConserved(w, id);
  });

  test('missed deadline: the held part goes to the payer as compensation', () => {
    const { w, id } = held();
    w.chain.advanceKeyblocks(21);
    call(w, id, 'shipper', 'refund_after_deadline');
    assert.equal(paidTo(w, id, w.a.shipper), 10_400n);
    assert.equal(paidTo(w, id, w.a.forwarder), 0n);
    assert.ok(w.chain.events(id).some((e) => e.type === 'BondReleased' && e.toPayee === 0n && e.toPayer === 400n), 'BondReleased says who got the held bond');
    assertConserved(w, id);
  });

  for (const [pct, toPayee, toPayer] of [[0n, 0n, 400n], [33n, 132n, 268n], [100n, 400n, 0n]]) {
    test(`dispute ${pct}% to the payee: the held part splits the same way`, () => {
      const { w, id } = held();
      call(w, id, 'shipper', 'raise_dispute');
      call(w, id, 'arbiter', 'vote', { payCarrierPct: pct });
      assert.equal(paidTo(w, id, w.a.forwarder), (10_000n * pct) / 100n + toPayee);
      assert.equal(paidTo(w, id, w.a.shipper), 10_000n - (10_000n * pct) / 100n + toPayer);
      assertConserved(w, id);
    });
  }

  test('rounding on an odd held amount goes to the payer', () => {
    const w = world({ bondBps: 1_000, bps: 0 });
    const id = book(w, { price: 1_001n }); // bond 100, fee 0, all held
    call(w, id, 'shipper', 'raise_dispute');
    call(w, id, 'arbiter', 'vote', { payCarrierPct: 33n });
    assert.equal(paidTo(w, id, w.a.forwarder), 330n + 33n);
    assert.equal(paidTo(w, id, w.a.shipper), 671n + 67n);
    assertConserved(w, id);
  });
});

describe('the fee is fixed when the quote is requested', () => {
  test('a vote during the negotiation does not change the fee, bond or treasury', () => {
    const w = world();
    const agreed = agree(w, { price: 10_000n });
    w.vote({ type: 'SetSetting', key: 'fee_bps', value: MAX_FEE_BPS });
    w.vote({ type: 'SetSetting', key: 'bond_bps', value: MAX_FEE_BPS });
    w.vote({ type: 'SetTreasury', treasury: 'ak_demo_new_treasury' });
    const id = create(w, agreed);
    assert.equal(requiredBond(w, id), 100n);
    confirm(w, id, 'forwarder');
    assert.equal(w.chain.balanceOf(TREASURY), 100n);
  });

  test('a quote requested after the vote uses the new rate and treasury', () => {
    const w = world();
    w.vote({ type: 'SetSetting', key: 'fee_bps', value: MAX_FEE_BPS });
    w.vote({ type: 'SetTreasury', treasury: 'ak_demo_new_treasury' });
    const id = book(w, { price: 10_000n });
    assert.deepEqual(feesPaid(w, id), [1_000n]);
    assert.equal(w.chain.balanceOf('ak_demo_new_treasury'), 1_000n);
  });

  test('the quote shows its fee terms to both sides', () => {
    const w = world({ bps: 150, min: 7n, bondBps: 20 });
    const { quote } = agree(w, { price: 1_000n });
    assert.deepEqual(w.chain.view(quote, 'fees'), { feeBps: 150, minFee: 7n, bondBps: 20, confirmWindow: CONFIRM_WINDOW, arbiterFeeBps: 0, minArbiterFee: 0n, depositWindow: 1_440, treasury: TREASURY });
  });
});

describe('legs', () => {
  function withParent(opts = {}, price = 10_000n) {
    const w = world(opts);
    const main = book(w, { price, deadlineIn: 50 });
    return { w, main };
  }

  test('a leg is funded with its price only, its carrier confirms, and no fee is charged', () => {
    const { w, main } = withParent({ min: 50n });
    const agreed = agree(w, { payer: 'forwarder', payee: 'carrier', price: 4_000n, parent: main });
    const id = create(w, agreed);
    assert.equal(requiredBond(w, id), 0n);
    confirm(w, id, 'carrier', 0n);
    deliver(w, id);
    assert.deepEqual(feesPaid(w, id), []);
    assert.equal(paidTo(w, id, w.a.carrier), 4_000n);
    assertConserved(w, id);
  });

  test('a leg’s carrier stakes bond_bps when it is set, held the same way', () => {
    const { w, main } = withParent({ bondBps: 200 });
    const id = leg(w, main, 4_000n);
    assert.equal(w.chain.balanceOf(id), 4_080n);
    w.chain.advanceKeyblocks(51);
    call(w, id, 'forwarder', 'refund_after_deadline');
    assert.equal(paidTo(w, id, w.a.forwarder), 4_080n, 'the forwarder is compensated');
    assertConserved(w, id);
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
    assert.throws(() => call(w, w.platform, 'carrier', 'new_quote', { invited: [w.a.stranger], job: H, consignment: CONSIGNMENT, dispute: DISPUTE, parent: id }), { code: 'NOT_MAIN' });
  });

  test('only the parent’s payee can open a leg quote (NOT_PAYEE)', () => {
    const { w, main } = withParent();
    for (const role of ['shipper', 'carrier', 'stranger']) {
      assert.throws(() => call(w, w.platform, role, 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, dispute: DISPUTE, parent: main }), { code: 'NOT_PAYEE' }, role);
    }
  });

  test('a settled parent can’t take new legs (BAD_STATE)', () => {
    const { w, main } = withParent();
    deliver(w, main);
    assert.throws(() => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, dispute: DISPUTE, parent: main }), { code: 'BAD_STATE' });
  });

  test('the parent must be a genuine escrow (UNKNOWN_ESCROW)', () => {
    const { w, main } = withParent();
    const legQuote = (parent) => () => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, dispute: DISPUTE, parent });
    assert.throws(legQuote(w.a.stranger), { code: 'UNKNOWN_ESCROW' }, 'a plain account');
    assert.throws(legQuote(w.platform), { code: 'UNKNOWN_ESCROW' }, 'another kind of contract');
    // Booked by another platform: genuine there, unknown here.
    const { result: p2 } = w.chain.deploy(Platform, w.a.admin1, { admins: [w.a.admin1], quorum: 1, treasury: TREASURY });
    installFor(w.chain, p2, w.a.admin1);
    verifyArbiters(w.chain, p2, w.a.admin1, [w.a.arbiter]);
    const foreign = book({ ...w, platform: p2 }, { price: 10_000n });
    assert.throws(legQuote(foreign), { code: 'UNKNOWN_ESCROW' }, 'another platform’s escrow');
    assert.doesNotThrow(legQuote(main));
  });

  test('an escrow created directly, even from this platform\'s template code, is not genuine (UNKNOWN_ESCROW)', () => {
    const { w } = withParent();
    const { result: fake } = w.chain.deploy(escrowFor(w.platform), w.a.forwarder, {});
    assert.throws(() => call(w, w.platform, 'forwarder', 'new_quote', { invited: [w.a.carrier], job: H, consignment: CONSIGNMENT, dispute: DISPUTE, parent: fake }), { code: 'UNKNOWN_ESCROW' });
    assert.equal(w.chain.view(w.platform, 'is_escrow', { address: fake }), false);
  });

  test('a parent must be in the registry, even before any template is voted in (UNKNOWN_ESCROW)', () => {
    const chain = new SimChain();
    const admin = chain.createAccount('admin', 1_000_000n);
    const { result: platform } = chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury: TREASURY });
    assert.throws(() => chain.call(platform, 'new_quote', { invited: ['ak_demo_x'], job: H, consignment: CONSIGNMENT, dispute: DISPUTE, parent: platform }, { caller: admin }), { code: 'UNKNOWN_ESCROW' });
  });
});

describe('release_leg returns a finished leg\'s unused budget to its parent (ADR 0011)', () => {
  function withLeg() {
    const w = world({ min: 0n });
    const main = book(w, { price: 10_000n, deadlineIn: 50 });
    const id = leg(w, main, 6_000n, { deadlineIn: 5 });
    return { w, main, id };
  }
  const release = (w, id, role = 'stranger') => call(w, w.platform, role, 'release_leg', { leg: id });

  test('after a refunded leg, anyone returns its price, so a replacement carrier fits', () => {
    const { w, main, id } = withLeg();
    assert.throws(() => leg(w, main, 4_001n), { code: 'LEG_TOO_LARGE' });
    w.chain.advanceKeyblocks(6);
    call(w, id, 'forwarder', 'refund_after_deadline');
    release(w, id);
    assert.partialDeepStrictEqual(w.chain.events(w.platform).at(-1), { type: 'LegReleased', leg: id, returned: 6_000n });
    assert.doesNotThrow(() => leg(w, main, 10_000n));
  });
  test('only the part never paid to the carrier comes back', () => {
    const { w, main, id } = withLeg();
    deliver(w, id);
    release(w, id);
    assert.partialDeepStrictEqual(w.chain.events(w.platform).at(-1), { type: 'LegReleased', returned: 0n });
    assert.throws(() => leg(w, main, 4_001n), { code: 'LEG_TOO_LARGE' });
  });
  test('an open leg can\'t be released (LEG_OPEN)', () => {
    const { w, id } = withLeg();
    assert.throws(() => release(w, id), { code: 'LEG_OPEN' });
  });
  test('a leg is released once (LEG_RELEASED)', () => {
    const { w, id } = withLeg();
    deliver(w, id);
    release(w, id);
    assert.throws(() => release(w, id), { code: 'LEG_RELEASED' });
  });
  test('a main escrow, or anything the platform never booked, is NOT_LEG', () => {
    const { w, main } = withLeg();
    assert.throws(() => release(w, main), { code: 'NOT_LEG' });
    assert.throws(() => release(w, w.a.stranger), { code: 'NOT_LEG' });
  });
});

describe('templates and the booking switch (ADR 0011)', () => {
  const bare = () => {
    const chain = new SimChain();
    const admin = chain.createAccount('admin', 1_000_000n);
    const { result: platform } = chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury: TREASURY });
    return { chain, admin, platform, vote: (change) => chain.call(platform, 'propose', { change }, { caller: admin }) };
  };
  test('no quotes until the quote template is voted in (NO_TEMPLATE)', () => {
    const { chain, admin, platform } = bare();
    verifyArbiters(chain, platform, admin, ['ak_demo_arbiter']);
    assert.throws(() => chain.call(platform, 'new_quote', { invited: ['ak_demo_x'], job: H, consignment: CONSIGNMENT, dispute: DISPUTE }, { caller: admin }), { code: 'NO_TEMPLATE' });
  });
  test('a template must be a contract (BAD_SETTING)', () => {
    const { vote } = bare();
    assert.throws(() => vote({ type: 'SetEscrowTemplate', template: 'ak_demo_account' }), { code: 'BAD_SETTING' });
    assert.throws(() => vote({ type: 'SetQuoteTemplate', template: 'ak_demo_account' }), { code: 'BAD_SETTING' });
  });
  test('bookings closed stop new quotes (BOOKINGS_CLOSED), and reopen on a vote', () => {
    const w = world();
    w.vote({ type: 'SetSetting', key: 'bookings_open', value: 0 });
    assert.throws(() => agree(w, { price: 10_000n }), { code: 'BOOKINGS_CLOSED' });
    w.vote({ type: 'SetSetting', key: 'bookings_open', value: 1 });
    assert.doesNotThrow(() => agree(w, { price: 10_000n }));
  });
  test('bookings_open is 0 or 1 only (BAD_SETTING)', () => {
    const w = world();
    for (const value of [2, -1]) assert.throws(() => w.vote({ type: 'SetSetting', key: 'bookings_open', value }), { code: 'BAD_SETTING' }, String(value));
  });
  test('a request may invite max_invited forwarders, and no more (BAD_INVITED)', () => {
    const w = world();
    w.vote({ type: 'SetSetting', key: 'max_invited', value: 2 });
    const ask = (n) => () => call(w, w.platform, 'shipper', 'new_quote', { invited: Array.from({ length: n }, (_, i) => `ak_demo_f${i}`), job: H, consignment: CONSIGNMENT, dispute: DISPUTE });
    assert.doesNotThrow(ask(2));
    assert.throws(ask(3), { code: 'BAD_INVITED' });
  });
  test('a proposal expires proposal_ttl blocks after it is made (PROPOSAL_EXPIRED)', () => {
    const w = world({ quorum: 2 });
    const ttl = w.chain.view(w.platform, 'setting', { key: 'proposal_ttl' });
    const { result: id } = call(w, w.platform, 'admin1', 'propose', { change: { type: 'SetSetting', key: 'fee_bps', value: 7 } });
    w.chain.advanceKeyblocks(ttl + 1);
    assert.throws(() => call(w, w.platform, 'admin2', 'approve', { id }), { code: 'PROPOSAL_EXPIRED' });
    const { result: again } = call(w, w.platform, 'admin1', 'propose', { change: { type: 'SetSetting', key: 'fee_bps', value: 7 } });
    w.chain.advanceKeyblocks(ttl);
    assert.doesNotThrow(() => call(w, w.platform, 'admin2', 'approve', { id: again }), 'still open at the last block');
  });
});

describe('fee settings are voted like the others', () => {
  for (const key of ['fee_bps', 'bond_bps']) {
    test(`${key} accepts 0 and the 10% cap, and rejects values outside or not whole (BAD_SETTING)`, () => {
      const w = world();
      for (const value of [0, MAX_FEE_BPS]) assert.doesNotThrow(() => w.vote({ type: 'SetSetting', key, value }));
      for (const value of [-1, MAX_FEE_BPS + 1, 1.5, 100n]) {
        assert.throws(() => w.vote({ type: 'SetSetting', key, value }), { code: 'BAD_SETTING' }, String(value));
      }
    });
  }

  test('confirm_window must be at least 1 block (BAD_SETTING)', () => {
    const w = world();
    assert.doesNotThrow(() => w.vote({ type: 'SetSetting', key: 'confirm_window', value: 1 }));
    for (const value of [0, -1, 1.5]) assert.throws(() => w.vote({ type: 'SetSetting', key: 'confirm_window', value }), { code: 'BAD_SETTING' }, String(value));
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

  test('rejects an empty or non-payable treasury (BAD_SETTING)', () => {
    const w = world();
    assert.throws(() => w.vote({ type: 'SetTreasury', treasury: '' }), { code: 'BAD_SETTING' });
    assert.throws(() => w.vote({ type: 'SetTreasury', treasury: w.platform }), { code: 'BAD_SETTING' }, 'the platform takes no spends');
  });

  test('a platform needs a treasury (BAD_TREASURY)', () => {
    const chain = new SimChain();
    const admin = chain.createAccount('admin', 0n);
    for (const treasury of [undefined, '']) {
      assert.throws(() => chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury }), { code: 'BAD_TREASURY' });
    }
  });

  test('starts at 1% with a 1 Gaju minimum, no bond above the fee, and a one-day confirm window', () => {
    const chain = new SimChain();
    const admin = chain.createAccount('admin', 0n);
    const { result: p } = chain.deploy(Platform, admin, { admins: [admin], quorum: 1, treasury: TREASURY });
    assert.equal(chain.view(p, 'setting', { key: 'fee_bps' }), 100);
    assert.equal(chain.view(p, 'setting', { key: 'min_fee' }), 10n ** 18n);
    assert.equal(chain.view(p, 'setting', { key: 'bond_bps' }), 0);
    assert.equal(chain.view(p, 'setting', { key: 'confirm_window' }), 480);
  });
});

test('property: random histories with confirm, cancel and bonds conserve funds (seeded)', () => {
  const seed = 0x0b0d;
  let x = seed;
  const rand = (n) => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x % n);
  for (let run = 0; run < 200; run++) {
    const w = world({ bps: [0, 100, 250, MAX_FEE_BPS][rand(4)], min: [0n, 7n, 500n][rand(3)], bondBps: [0, 1, 300, MAX_FEE_BPS][rand(4)] });
    const supply = w.chain.totalSupply();
    const main = book(w, { price: 10_000n, schedule: [['A', 30]], deadlineIn: 20 });
    const legs = [0, 1].map(() => create(w, agree(w, { payer: 'forwarder', payee: 'carrier', price: BigInt(1 + rand(5_000)), parent: main, deadlineIn: 20 })));
    const someLeg = () => legs[rand(2)];
    const actions = [
      () => call(w, main, 'attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H }),
      () => deliver(w, main),
      () => call(w, main, 'shipper', 'raise_dispute'),
      () => call(w, main, 'arbiter', 'vote', { payCarrierPct: BigInt(rand(101)) }),
      () => call(w, main, 'shipper', 'refund_after_deadline'),
      () => confirm(w, someLeg(), 'carrier'),
      () => call(w, someLeg(), ['forwarder', 'carrier'][rand(2)], 'cancel_booking'),
      () => deliver(w, someLeg()),
      () => call(w, someLeg(), 'forwarder', 'raise_dispute'),
      () => call(w, someLeg(), 'arbiter', 'vote', { payCarrierPct: BigInt(rand(101)) }),
      () => call(w, someLeg(), 'forwarder', 'refund_after_deadline'),
      () => w.chain.advanceKeyblocks(rand(15)),
    ];
    for (let i = 0; i < 18; i++) {
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
