// Verified, paid and fairly chosen arbiters (ADR 0022). Panels hold only verified arbiters; the
// forwarder may swap one arbiter in its quote. A dispute is raised by the payer or payee with a
// deposit equal to the arbiter fee, or flagged by an attestor for the consignee and funded by
// the shipper. Voting arbiters share the fee whichever way they rule; the deposit goes back to
// a raiser who wins at least half, otherwise to the other side.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain, codeHash } from '../lib/sim-chain.js';
import { escrowFor, Status } from '../lib/shipment-escrow.js';
import { jobHash, termsHash, quoteTerms } from '../lib/quote-request.js';
import { Platform } from '../lib/platform.js';
import { CONSIGNMENT } from '../lib/fixtures.js';
import { verifyArbiters } from './support.js';

const H = 'a'.repeat(64);
const TREASURY = 'ak_demo_treasury';
const ROLES = ['admin', 'shipper', 'forwarder', 'consignee', 'attestor', 'arb1', 'arb2', 'arb3', 'arb4', 'stranger'];
const WINDOW = 5;
const DEPOSIT_WINDOW = 4;

function world({ arbiterBps = 200, minArbiterFee = 0n, verified = ['arb1', 'arb2', 'arb3', 'arb4'] } = {}) {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 1_000_000n)]));
  const { result: platform } = chain.deploy(Platform, a.admin, { admins: [a.admin], quorum: 1, treasury: TREASURY });
  const vote = (key, value) => chain.call(platform, 'propose', { change: { type: 'SetSetting', key, value } }, { caller: a.admin });
  vote('fee_bps', 0);
  vote('min_fee', 0n);
  vote('arbiter_fee_bps', arbiterBps);
  vote('min_arbiter_fee', minArbiterFee);
  vote('deposit_window', DEPOSIT_WINDOW);
  const escrow = escrowFor(platform);
  chain.call(platform, 'propose', { change: { type: 'SetEscrowCode', hash: codeHash(escrow) } }, { caller: a.admin });
  verifyArbiters(chain, platform, a.admin, verified.map((r) => a[r]));
  return { chain, a, platform, escrow };
}

const dispute = (w, panel = ['arb1', 'arb2', 'arb3'], quorum = 2) => ({ panel: panel.map((r) => w.a[r]), quorum, window: WINDOW, fallback: 50, challenge: 1 });

// Requests, quotes (with an optional arbiter swap), accepts, books and confirms.
function booked(w, { price = 10_000n, replace = null, panel, quorum, schedule = [] } = {}) {
  const { chain, a } = w;
  const d = dispute(w, panel, quorum);
  const deadline = chain.keyHeight + 50;
  const quoted = { price, schedule, attestors: [a.attestor], deadline };
  const finalPanel = replace ? d.panel.map((p) => (p === replace[0] ? replace[1] : p)) : d.panel;
  // The escrow books the agreed terms: the quote plus the request's dispute terms, swap applied.
  const args = { carrier: a.forwarder, consignee: a.consignee, attestors: [a.attestor], panel: finalPanel, quorum: d.quorum, window: WINDOW, fallback: 50n, manifest: 'm'.repeat(64), deadline, terms: { ...quoted, ...d, panel: finalPanel } };
  const offer = { ...quoted, replace };
  const { result: quote } = chain.call(w.platform, 'new_quote', { invited: [a.forwarder], job: jobHash(args), consignment: CONSIGNMENT, dispute: d }, { caller: a.shipper });
  chain.call(quote, 'quote', { terms: offer, validUntil: chain.keyHeight + 100 }, { caller: a.forwarder });
  chain.call(quote, 'accept', { invitee: a.forwarder, terms: termsHash(quoteTerms(offer)) }, { caller: a.shipper });
  const { result: id } = chain.deploy(w.escrow, a.shipper, { ...args, quote }, { value: price });
  chain.call(id, 'confirm', {}, { caller: a.forwarder, value: chain.contractState(id).bond });
  return { id, quote };
}

const call = (w, id, role, ep, args = {}, value = 0n) => w.chain.call(id, ep, args, { caller: w.a[role], value });
const deposit = (w, id) => w.chain.view(id, 'deposit_due');
const raise = (w, id, role = 'shipper') => call(w, id, role, 'raise_dispute', {}, deposit(w, id));
const paidTo = (w, id, role) => w.chain.events(id).filter((e) => e.type === 'Paid' && e.to === w.a[role]).reduce((s, e) => s + e.amount, 0n);

describe('panels hold only verified arbiters', () => {
  test('a request naming an unverified arbiter is refused (UNVERIFIED_ARBITER)', () => {
    const w = world({ verified: ['arb1', 'arb2'] });
    assert.throws(() => booked(w), { code: 'UNVERIFIED_ARBITER' });
  });

  test('a revoked or expired verification no longer counts', () => {
    const w = world();
    w.chain.call(w.platform, 'revoke', { account: w.a.arb3 }, { caller: w.a.admin });
    assert.throws(() => booked(w), { code: 'UNVERIFIED_ARBITER' });
  });

  test('a verified business without the Arbiter role is refused', () => {
    const w = world({ verified: ['arb1', 'arb2'] });
    w.chain.call(w.platform, 'verify', { account: w.a.arb3, commitment: H, expires: 10 ** 9, roles: ['Forwarder'] }, { caller: w.a.admin });
    assert.throws(() => booked(w), { code: 'UNVERIFIED_ARBITER' });
  });
});

describe('verification roles', () => {
  test('has_role is true only for a current record holding that role', () => {
    const w = world({ verified: [] });
    const has = (role) => w.chain.view(w.platform, 'has_role', { account: w.a.arb1, role });
    assert.equal(has('Arbiter'), false);
    w.chain.call(w.platform, 'verify', { account: w.a.arb1, commitment: H, expires: w.chain.keyHeight + 3, roles: ['Arbiter', 'Attestor'] }, { caller: w.a.admin });
    assert.equal(has('Arbiter'), true);
    assert.equal(has('Attestor'), true);
    assert.equal(has('Carrier'), false);
    w.chain.advanceKeyblocks(4);
    assert.equal(has('Arbiter'), false, 'expired');
  });

  test('roles must be known, distinct and at least one (BAD_ROLES)', () => {
    const w = world({ verified: [] });
    for (const roles of [[], ['Arbiter', 'Arbiter'], ['Judge']]) {
      assert.throws(() => w.chain.call(w.platform, 'verify', { account: w.a.arb1, commitment: H, expires: 10 ** 9, roles }, { caller: w.a.admin }), { code: 'BAD_ROLES' }, JSON.stringify(roles));
    }
  });
});

describe('the forwarder can replace one arbiter in its quote', () => {
  test('the agreed panel is the request panel with the swap applied', () => {
    const w = world();
    const { id } = booked(w, { replace: [w.a.arb3, w.a.arb4] });
    assert.deepEqual(w.chain.contractState(id).arbiters, [w.a.arb1, w.a.arb2, w.a.arb4]);
  });

  test('the outgoing arbiter must be on the panel and the newcomer not (BAD_REPLACEMENT)', () => {
    const w = world();
    assert.throws(() => booked(w, { replace: [w.a.arb4, w.a.arb3] }), { code: 'BAD_REPLACEMENT' }, 'outgoing not on panel');
    assert.throws(() => booked(w, { replace: [w.a.arb3, w.a.arb1] }), { code: 'BAD_REPLACEMENT' }, 'newcomer already on panel');
  });

  test('the newcomer must be a verified arbiter (UNVERIFIED_ARBITER) and not a party (CONFLICTED_ARBITER)', () => {
    const w = world();
    assert.throws(() => booked(w, { replace: [w.a.arb3, w.a.stranger] }), { code: 'UNVERIFIED_ARBITER' });
    verifyArbiters(w.chain, w.platform, w.a.admin, [w.a.forwarder]);
    assert.throws(() => booked(w, { replace: [w.a.arb3, w.a.forwarder] }), { code: 'CONFLICTED_ARBITER' });
  });
});

describe('raising a dispute', () => {
  test('the payer or payee raises it with a deposit equal to the arbiter fee (2% of the remainder)', () => {
    for (const role of ['shipper', 'forwarder']) {
      const w = world();
      const { id } = booked(w);
      assert.equal(deposit(w, id), 200n);
      for (const value of [199n, 201n]) assert.throws(() => call(w, id, role, 'raise_dispute', {}, value), { code: 'WRONG_AMOUNT' }, String(value));
      call(w, id, role, 'raise_dispute', {}, 200n);
      assert.equal(w.chain.contractState(id).status, Status.Disputed);
      assert.equal(w.chain.balanceOf(id), 10_200n);
    }
  });

  test('the consignee and strangers cannot raise one (UNAUTHORIZED)', () => {
    const w = world();
    const { id } = booked(w);
    for (const role of ['consignee', 'attestor', 'arb1', 'stranger']) assert.throws(() => call(w, id, role, 'raise_dispute', {}, 200n), { code: 'UNAUTHORIZED' }, role);
  });

  test('the minimum fee applies, but never more than the remainder', () => {
    const w = world({ arbiterBps: 0, minArbiterFee: 500n });
    assert.equal(deposit(w, booked(w).id), 500n);
    const w2 = world({ arbiterBps: 0, minArbiterFee: 50_000n });
    assert.equal(deposit(w2, booked(w2).id), 10_000n, 'capped at the remainder');
  });
});

describe('a consignee problem flagged by the final-mile agent', () => {
  test('an attestor flags it; the shipper raises it with the deposit within the window', () => {
    const w = world();
    const { id } = booked(w);
    call(w, id, 'attestor', 'flag_dispute', { evidence: H });
    assert.equal(w.chain.contractState(id).status, Status.DisputeFlagged);
    assert.throws(() => call(w, id, 'consignee', 'raise_dispute', {}, 200n), { code: 'UNAUTHORIZED' });
    assert.throws(() => call(w, id, 'shipper', 'raise_dispute', {}, 199n), { code: 'WRONG_AMOUNT' });
    w.chain.advanceKeyblocks(DEPOSIT_WINDOW);
    call(w, id, 'shipper', 'raise_dispute', {}, 200n);
    assert.equal(w.chain.contractState(id).status, Status.Disputed);
  });

  test('the forwarder can also raise a flagged dispute within the window, becoming the raiser', () => {
    const w = world();
    const { id } = booked(w, { quorum: 1 });
    call(w, id, 'attestor', 'flag_dispute', { evidence: H });
    call(w, id, 'forwarder', 'raise_dispute', {}, 200n);
    call(w, id, 'arb1', 'vote', { payCarrierPct: 60n });
    assert.ok(w.chain.events(id).some((e) => e.type === 'DepositReturned' && e.to === w.a.forwarder));
  });

  test('only an attestor flags (UNAUTHORIZED); the consignee never pays or signs', () => {
    const w = world();
    const { id } = booked(w);
    for (const role of ['consignee', 'shipper', 'forwarder', 'stranger']) assert.throws(() => call(w, id, role, 'flag_dispute', { evidence: H }), { code: 'UNAUTHORIZED' }, role);
  });

  test('unfunded, it lapses after the window and the shipment carries on', () => {
    const w = world();
    const { id } = booked(w);
    call(w, id, 'attestor', 'add_checkpoint', { location: 'X', kind: 'Milestone', evidence: H });
    call(w, id, 'attestor', 'flag_dispute', { evidence: H });
    assert.throws(() => call(w, id, 'attestor', 'add_checkpoint', { location: 'Y', kind: 'Milestone', evidence: H }), { code: 'BAD_STATE' }, 'frozen while flagged');
    assert.throws(() => call(w, id, 'stranger', 'lapse_dispute'), { code: 'DEPOSIT_WINDOW_OPEN' });
    w.chain.advanceKeyblocks(DEPOSIT_WINDOW + 1);
    assert.throws(() => call(w, id, 'shipper', 'raise_dispute', {}, 200n), { code: 'DEPOSIT_EXPIRED' });
    call(w, id, 'stranger', 'lapse_dispute');
    assert.equal(w.chain.contractState(id).status, Status.InTransit);
  });
});

describe('no single party can freeze the escrow with flags', () => {
  test('one flag per escrow: after a lapse, it cannot be flagged again (ALREADY_FLAGGED)', () => {
    const w = world();
    const { id } = booked(w);
    call(w, id, 'attestor', 'flag_dispute', { evidence: H });
    w.chain.advanceKeyblocks(DEPOSIT_WINDOW + 1);
    call(w, id, 'stranger', 'lapse_dispute');
    assert.throws(() => call(w, id, 'attestor', 'flag_dispute', { evidence: H }), { code: 'ALREADY_FLAGGED' });
    assert.doesNotThrow(() => raise(w, id), 'the parties can still raise a dispute themselves');
  });

  test('nothing to dispute once every milestone has paid the whole price (NOTHING_DISPUTED)', () => {
    const w = world();
    const { id } = booked(w, { schedule: [['CNYTN', 100]] });
    call(w, id, 'attestor', 'add_checkpoint', { location: 'CNYTN', kind: 'ScanIn', evidence: H });
    assert.equal(deposit(w, id), 0n);
    assert.throws(() => call(w, id, 'shipper', 'raise_dispute'), { code: 'NOTHING_DISPUTED' });
    assert.throws(() => call(w, id, 'attestor', 'flag_dispute', { evidence: H }), { code: 'NOTHING_DISPUTED' });
  });
});

describe('settling: arbiters paid whichever way they rule', () => {
  test('voting arbiters share the fee, the rest splits by the ruling', () => {
    const w = world();
    const { id } = booked(w);
    raise(w, id);
    call(w, id, 'arb1', 'vote', { payCarrierPct: 30n });
    call(w, id, 'arb2', 'vote', { payCarrierPct: 30n });
    assert.equal(paidTo(w, id, 'arb1'), 100n);
    assert.equal(paidTo(w, id, 'arb2'), 100n);
    assert.equal(paidTo(w, id, 'arb3'), 0n, 'a no-show is not paid');
    assert.equal(paidTo(w, id, 'forwarder'), 2_940n, '30% of the 9,800 left');
    assert.equal(w.chain.balanceOf(id), 0n);
  });

  for (const n of [1, 3]) {
    test(`${n} voter(s) share it equally, with rounding left in the split`, () => {
      const w = world();
      const { id } = booked(w, { quorum: n === 1 ? 1 : 3 });
      raise(w, id);
      for (const r of ['arb1', 'arb2', 'arb3'].slice(0, n)) call(w, id, r, 'vote', { payCarrierPct: 50n });
      const share = 200n / BigInt(n);
      for (const r of ['arb1', 'arb2', 'arb3'].slice(0, n)) assert.equal(paidTo(w, id, r), share, r);
      assert.equal(w.chain.balanceOf(id), 0n);
    });
  }

  test('a fallback with nobody voting pays no fee', () => {
    const w = world();
    const { id } = booked(w);
    raise(w, id);
    w.chain.advanceKeyblocks(WINDOW + 1);
    call(w, id, 'shipper', 'resolve_by_fallback');
    for (const r of ['arb1', 'arb2', 'arb3']) assert.equal(paidTo(w, id, r), 0n, r);
    assert.equal(w.chain.balanceOf(id), 0n);
  });

  test('voters are paid on a fallback too, even without a quorum', () => {
    const w = world();
    const { id } = booked(w);
    raise(w, id);
    call(w, id, 'arb1', 'vote', { payCarrierPct: 10n });
    call(w, id, 'arb2', 'vote', { payCarrierPct: 90n });
    w.chain.advanceKeyblocks(WINDOW + 1);
    call(w, id, 'shipper', 'resolve_by_fallback');
    assert.equal(paidTo(w, id, 'arb1'), 100n);
    assert.equal(paidTo(w, id, 'arb2'), 100n);
  });
});

describe('the deposit: back to a raiser who wins at least half, else to the other side', () => {
  for (const [raiser, pct, winner] of [
    ['shipper', 49n, 'shipper'], ['shipper', 50n, 'shipper'], ['shipper', 51n, 'forwarder'],
    ['forwarder', 49n, 'shipper'], ['forwarder', 50n, 'forwarder'], ['forwarder', 51n, 'forwarder'],
  ]) {
    test(`${raiser} raises, ${pct}% to the payee → deposit to the ${winner}`, () => {
      const w = world();
      const { id } = booked(w, { quorum: 1 });
      raise(w, id, raiser);
      call(w, id, 'arb1', 'vote', { payCarrierPct: pct });
      const to = w.chain.events(id).find((e) => e.type === 'DepositReturned' || e.type === 'DepositForfeited');
      assert.equal(to.to, w.a[winner]);
      assert.equal(to.type, winner === raiser ? 'DepositReturned' : 'DepositForfeited');
      assert.equal(to.amount, 200n);
    });
  }

  test('a flagged dispute funded by the shipper treats the shipper as the raiser', () => {
    const w = world();
    const { id } = booked(w, { quorum: 1 });
    call(w, id, 'attestor', 'flag_dispute', { evidence: H });
    call(w, id, 'shipper', 'raise_dispute', {}, 200n);
    call(w, id, 'arb1', 'vote', { payCarrierPct: 20n });
    assert.ok(w.chain.events(id).some((e) => e.type === 'DepositReturned' && e.to === w.a.shipper));
  });
});

test('property: disputes, deposits and fees conserve funds (seeded)', () => {
  const seed = 0x0a7b;
  let x = seed;
  const rand = (n) => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x % n);
  for (let run = 0; run < 150; run++) {
    const w = world({ arbiterBps: [0, 200, 1000][rand(3)], minArbiterFee: [0n, 7n, 300n][rand(3)] });
    const { id } = booked(w);
    const supply = w.chain.totalSupply();
    const actions = [
      () => raise(w, id, ['shipper', 'forwarder'][rand(2)]),
      () => call(w, id, 'attestor', 'flag_dispute', { evidence: H }),
      () => call(w, id, ['shipper', 'forwarder'][rand(2)], 'raise_dispute', {}, deposit(w, id)),
      () => call(w, id, 'stranger', 'lapse_dispute'),
      () => call(w, id, ['arb1', 'arb2', 'arb3'][rand(3)], 'vote', { payCarrierPct: BigInt([0, 49, 50, 51, 100][rand(5)]) }),
      () => call(w, id, 'shipper', 'resolve_by_fallback'),
      () => call(w, id, 'attestor', 'add_checkpoint', { location: 'X', kind: 'Milestone', evidence: H }),
      () => call(w, id, 'consignee', 'confirm_delivery', { evidence: H }),
      () => w.chain.advanceKeyblocks(rand(7)),
    ];
    for (let i = 0; i < 16; i++) {
      try {
        actions[rand(actions.length)]();
      } catch (e) {
        assert.ok(e.code, `seed=${seed} run=${run}: non-contract error ${e}`);
      }
      const s = w.chain.contractState(id);
      const staked = w.chain.events(id).some((e) => e.type === 'Confirmed') ? s.bond : 0n;
      assert.equal(w.chain.balanceOf(id), s.amount - s.paidOut + staked - s.bondOut + s.deposit - s.depositOut, `seed=${seed} run=${run}: escrow balance`);
      assert.equal(w.chain.totalSupply(), supply, `seed=${seed} run=${run}: supply`);
    }
  }
});
