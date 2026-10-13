// Extra charges and event milestones (ADR 0020). The payee proposes a charge after booking
// (demurrage, waiting time, duties paid for the shipper); the payer accepts and pays it straight
// to the payee in the same call, with no platform fee, or declines it and it's settled off-chain.
// Charges never touch the price, the held bond or the dispute and refund maths.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { Status, MAX_CHARGES } from '../lib/shipment-escrow.js';
import { jobHash, termsHash, quoteTerms } from '../lib/quote-request.js';
import { Platform } from '../lib/platform.js';
import { CONSIGNMENT } from '../lib/fixtures.js';
import { verifyArbiters, installFor } from './support.js';

const H = 'a'.repeat(64);
const TREASURY = 'ak_demo_treasury';
const ROLES = ['admin', 'shipper', 'forwarder', 'consignee', 'attestor', 'arbiter', 'stranger'];

// A platform with a 1% fee, an agreed quote for `price` and the escrow booked and confirmed.
function booked({ price = 10_000n, schedule = [], confirm = true } = {}) {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 1_000_000n)]));
  const { result: platform } = chain.deploy(Platform, a.admin, { admins: [a.admin], quorum: 1, treasury: TREASURY });
  installFor(chain, platform, a.admin);
  for (const [key, value] of [['arbiter_fee_bps', 0], ['min_arbiter_fee', 0n]]) chain.call(platform, 'propose', { change: { type: 'SetSetting', key, value } }, { caller: a.admin });
  verifyArbiters(chain, platform, a.admin, [a.arbiter]);
  const dispute = { panel: [a.arbiter], quorum: 1, window: 2, fallback: 50, challenge: 1 };
  const deadline = chain.keyHeight + 10;
  const args = { carrier: a.forwarder, consignee: a.consignee, attestors: [a.attestor], panel: dispute.panel, quorum: 1, window: 2, fallback: 50n, manifest: 'm'.repeat(64), terms: { price, schedule, attestors: [a.attestor], deadline, ...dispute }, deadline };
  const { result: quote } = chain.call(platform, 'new_quote', { invited: [a.forwarder], job: jobHash(args), consignment: CONSIGNMENT, dispute }, { caller: a.shipper });
  chain.call(quote, 'quote', { terms: args.terms, validUntil: chain.keyHeight + 100 }, { caller: a.forwarder });
  chain.call(quote, 'accept', { invitee: a.forwarder, terms: termsHash(quoteTerms(args.terms)) }, { caller: a.shipper });
  const { result: id } = chain.call(platform, 'book', { quote, manifest: args.manifest, consignee: args.consignee }, { caller: a.shipper, value: price });
  const call = (role, ep, params = {}, value = 0n) => chain.call(id, ep, params, { caller: a[role], value });
  if (confirm) call('forwarder', 'confirm', {}, chain.contractState(id).bond);
  return { chain, a, id, call };
}

const propose = (t, { kind = 'Demurrage', amount = 300n, role = 'forwarder' } = {}) => t.call(role, 'propose_charge', { kind, amount, evidence: H }).result;
const charge = (t, chargeId) => t.chain.view(t.id, 'charge', { id: chargeId });

describe('propose_charge', () => {
  test('records the charge as proposed and emits ChargeProposed', () => {
    const t = booked();
    const chargeId = propose(t);
    assert.deepEqual(charge(t, chargeId), { kind: 'Demurrage', amount: 300n, evidence: H, status: 'Proposed' });
    assert.ok(t.chain.events(t.id).some((e) => e.type === 'ChargeProposed' && e.id === chargeId && e.amount === 300n));
  });

  test('only the payee proposes (ONLY_PAYEE)', () => {
    const t = booked();
    for (const role of ['shipper', 'consignee', 'attestor', 'stranger']) assert.throws(() => propose(t, { role }), { code: 'ONLY_PAYEE' }, role);
  });

  test('not before the booking is confirmed (BAD_STATE)', () => {
    const t = booked({ confirm: false });
    assert.throws(() => propose(t), { code: 'BAD_STATE' });
  });

  test('not on a booking cancelled before it was confirmed (BAD_STATE)', () => {
    const t = booked({ confirm: false });
    t.call('shipper', 'cancel_booking');
    assert.equal(t.chain.contractState(t.id).status, Status.Refunded);
    assert.throws(() => propose(t), { code: 'BAD_STATE' });
  });

  test('allowed after delivery, because port storage is often billed then', () => {
    const t = booked();
    t.call('consignee', 'confirm_delivery', { evidence: H });
    assert.equal(t.chain.contractState(t.id).status, Status.Released);
    assert.doesNotThrow(() => propose(t));
  });

  test('the amount must be a positive whole amount (BAD_AMOUNT), and the kind known (BAD_KIND)', () => {
    const t = booked();
    for (const amount of [0n, -1n, 5]) assert.throws(() => propose(t, { amount }), { code: 'BAD_AMOUNT' }, String(amount));
    assert.throws(() => propose(t, { kind: 'Lunch' }), { code: 'BAD_KIND' });
    for (const kind of ['Demurrage', 'Detention', 'Waiting', 'Redelivery', 'Duty', 'Other']) assert.doesNotThrow(() => propose(t, { kind }), kind);
  });

  test(`at most ${MAX_CHARGES} charges per escrow (TOO_MANY_CHARGES)`, () => {
    const t = booked();
    for (let i = 0; i < MAX_CHARGES; i++) propose(t);
    assert.throws(() => propose(t), { code: 'TOO_MANY_CHARGES' });
  });
});

describe('charge read', () => {
  test('the charge read returns null for an unknown id', () => {
    const t = booked();
    assert.equal(charge(t, 0), null);
  });
});

describe('accept_charge', () => {
  test('pays the payee the full amount in the same call: no fee, and the escrow balance is unchanged', () => {
    const t = booked();
    const chargeId = propose(t);
    const before = { escrow: t.chain.balanceOf(t.id), payee: t.chain.balanceOf(t.a.forwarder), treasury: t.chain.balanceOf(TREASURY) };
    t.call('shipper', 'accept_charge', { id: chargeId }, 300n);
    assert.equal(t.chain.balanceOf(t.a.forwarder), before.payee + 300n);
    assert.equal(t.chain.balanceOf(t.id), before.escrow);
    assert.equal(t.chain.balanceOf(TREASURY), before.treasury);
    assert.equal(charge(t, chargeId).status, 'Accepted');
    assert.ok(t.chain.events(t.id).some((e) => e.type === 'ChargeAccepted' && e.id === chargeId));
  });

  test('only the payer accepts (ONLY_SHIPPER)', () => {
    const t = booked();
    const chargeId = propose(t);
    for (const role of ['forwarder', 'consignee', 'stranger']) assert.throws(() => t.call(role, 'accept_charge', { id: chargeId }, 300n), { code: 'ONLY_SHIPPER' }, role);
  });

  test('an unknown charge (NO_CHARGE), and only once (CHARGE_CLOSED)', () => {
    const t = booked();
    assert.throws(() => t.call('shipper', 'accept_charge', { id: 0 }, 300n), { code: 'NO_CHARGE' });
    const chargeId = propose(t);
    t.call('shipper', 'accept_charge', { id: chargeId }, 300n);
    assert.throws(() => t.call('shipper', 'accept_charge', { id: chargeId }, 300n), { code: 'CHARGE_CLOSED' });
  });

  test('with exactly the amount (WRONG_AMOUNT)', () => {
    const t = booked();
    const chargeId = propose(t);
    for (const value of [299n, 301n]) assert.throws(() => t.call('shipper', 'accept_charge', { id: chargeId }, value), { code: 'WRONG_AMOUNT' }, String(value));
  });

  test('a charge accepted after a dispute settles leaves the settlement untouched', () => {
    const t = booked();
    t.call('shipper', 'raise_dispute');
    t.call('arbiter', 'vote', { payCarrierPct: 40n });
    const chargeId = propose(t);
    t.call('shipper', 'accept_charge', { id: chargeId }, 300n);
    assert.equal(t.chain.balanceOf(t.id), 0n, 'the escrow is still empty');
  });
});

describe('decline_charge', () => {
  test('records the decline; nothing moves', () => {
    const t = booked();
    const chargeId = propose(t);
    const before = t.chain.balanceOf(t.a.forwarder);
    t.call('shipper', 'decline_charge', { id: chargeId });
    assert.equal(charge(t, chargeId).status, 'Declined');
    assert.equal(t.chain.balanceOf(t.a.forwarder), before);
    assert.ok(t.chain.events(t.id).some((e) => e.type === 'ChargeDeclined' && e.id === chargeId));
  });

  test('only the payer (ONLY_SHIPPER), a known charge (NO_CHARGE), still open (CHARGE_CLOSED)', () => {
    const t = booked();
    const chargeId = propose(t);
    assert.throws(() => t.call('forwarder', 'decline_charge', { id: chargeId }), { code: 'ONLY_SHIPPER' });
    assert.throws(() => t.call('shipper', 'decline_charge', { id: 99 }), { code: 'NO_CHARGE' });
    t.call('shipper', 'decline_charge', { id: chargeId });
    assert.throws(() => t.call('shipper', 'decline_charge', { id: chargeId }), { code: 'CHARGE_CLOSED' });
    assert.throws(() => t.call('shipper', 'accept_charge', { id: chargeId }, 300n), { code: 'CHARGE_CLOSED' });
  });
});

describe('event milestones', () => {
  const event = (t, role, kind, location) => t.call(role, 'add_checkpoint', { location, kind, evidence: H });
  const paidToPayee = (t) => t.chain.events(t.id).filter((e) => e.type === 'Paid' && e.to === t.a.forwarder).reduce((s, e) => s + e.amount, 0n);

  test("an attestor's milestone checkpoint pays a milestone labelled for an event", () => {
    const t = booked({ schedule: [['CUSTOMS:NLRTM', 30]] });
    event(t, 'attestor', 'Milestone', 'CUSTOMS:NLRTM');
    assert.equal(paidToPayee(t), 3_000n);
  });

  test("a scan-in can't pay an event milestone, and the payee can't attest one", () => {
    const t = booked({ schedule: [['CUSTOMS:NLRTM', 30]] });
    event(t, 'attestor', 'ScanIn', 'CUSTOMS:NLRTM');
    event(t, 'forwarder', 'Milestone', 'CUSTOMS:NLRTM');
    assert.equal(paidToPayee(t), 0n);
  });

  test('place and event milestones pay in order', () => {
    const t = booked({ schedule: [['CNYTN', 20], ['ONBOARD:CNYTN', 10]] });
    event(t, 'attestor', 'Milestone', 'ONBOARD:CNYTN');
    assert.equal(paidToPayee(t), 0n, 'not before the earlier place milestone');
    event(t, 'attestor', 'ScanIn', 'CNYTN');
    event(t, 'attestor', 'Milestone', 'ONBOARD:CNYTN');
    assert.equal(paidToPayee(t), 3_000n);
  });
});

test('property: charges pass straight through in any history, so escrows still conserve (seeded)', () => {
  const seed = 0x0c4a;
  let x = seed;
  const rand = (n) => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x % n);
  const kinds = ['Demurrage', 'Detention', 'Waiting', 'Redelivery', 'Duty', 'Other'];
  for (let run = 0; run < 150; run++) {
    const t = booked({ schedule: [['CNYTN', 20], ['CUSTOMS:NLRTM', 30]], confirm: rand(4) !== 0 });
    const supply = t.chain.totalSupply();
    const chargeIds = () => t.chain.contractState(t.id).charges.length;
    const someCharge = () => rand(chargeIds() + 1);
    const actions = [
      () => propose(t, { kind: kinds[rand(kinds.length)], amount: BigInt(1 + rand(500)) }),
      () => {
        const id = someCharge();
        const c = t.chain.contractState(t.id).charges[id];
        t.call('shipper', 'accept_charge', { id }, c?.amount ?? 1n);
      },
      () => t.call('shipper', 'decline_charge', { id: someCharge() }),
      () => t.call('forwarder', 'confirm', {}, t.chain.contractState(t.id).bond),
      () => t.call('shipper', 'cancel_booking'),
      () => t.call('attestor', 'add_checkpoint', { location: 'CNYTN', kind: 'ScanIn', evidence: H }),
      () => t.call('attestor', 'add_checkpoint', { location: 'CUSTOMS:NLRTM', kind: 'Milestone', evidence: H }),
      () => t.call('consignee', 'confirm_delivery', { evidence: H }),
      () => t.call('shipper', 'raise_dispute'),
      () => t.call('arbiter', 'vote', { payCarrierPct: BigInt(rand(101)) }),
      () => t.chain.advanceKeyblocks(rand(6)),
    ];
    for (let i = 0; i < 16; i++) {
      try {
        actions[rand(actions.length)]();
      } catch (e) {
        assert.ok(e.code, `seed=${seed} run=${run}: non-contract error ${e}`);
      }
      const s = t.chain.contractState(t.id);
      const staked = t.chain.events(t.id).some((e) => e.type === 'Confirmed') ? s.bond : 0n;
      assert.equal(t.chain.balanceOf(t.id), s.amount - s.paidOut + staked - s.bondOut, `seed=${seed} run=${run}: escrow balance`);
      assert.equal(t.chain.totalSupply(), supply, `seed=${seed} run=${run}: supply changed`);
    }
  }
});

