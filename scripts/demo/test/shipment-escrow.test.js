import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { ShipmentEscrow, Status, TERMINAL } from '../lib/shipment-escrow.js';
import { QuoteRequest, termsHash } from '../lib/quote-request.js';

const AMOUNT = 1_000n;
const DEADLINE_IN = 10;
const WINDOW = 5; // arbitration window, in blocks
const QUORUM = 2; // of a three-arbiter panel
const H = 'a'.repeat(64);
const ARBITERS = ['arbiter', 'arbiter2', 'arbiter3'];
const ROLES = ['shipper', 'carrier', 'consignee', 'attestor', ...ARBITERS, 'stranger'];

// Agrees terms through a real QuoteRequest, so every escrow passes the NOT_AGREED gate.
function agreeQuote(chain, requester, payee, terms) {
  const { result: quote } = chain.deploy(QuoteRequest, requester, { invited: [payee], job: 'j' });
  chain.call(quote, 'propose', { invitee: payee, terms: termsHash(terms), validUntil: chain.keyHeight + 100 }, { caller: payee });
  chain.call(quote, 'accept', { invitee: payee, terms: termsHash(terms) }, { caller: requester });
  return quote;
}

function setup({ amount = AMOUNT, quorum = QUORUM, fallback, manifest = 'c'.repeat(64), schedule = [] } = {}) {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
  const terms = { price: amount, schedule };
  const quote = agreeQuote(chain, a.shipper, a.carrier, terms);
  const { result: id } = chain.deploy(ShipmentEscrow, a.shipper, {
    carrier: a.carrier,
    consignee: a.consignee,
    attestors: [a.attestor],
    panel: ARBITERS.map((r) => a[r]),
    quorum,
    window: WINDOW,
    fallback,
    manifest,
    quote,
    terms,
    deadline: chain.keyHeight + DEADLINE_IN,
  });
  const call = (role, ep, args = {}, value = 0n) => chain.call(id, ep, args, { caller: a[role], value });
  const status = () => chain.contractState(id).status;
  return { chain, a, id, call, status, amount };
}

// Drive a fresh contract into the given status.
function inStatus(target) {
  const t = setup();
  if (target === Status.Created) return t;

  t.call('shipper', 'fund', {}, AMOUNT);
  switch (target) {
    case Status.Funded:
      break;
    case Status.InTransit:
      t.call('carrier', 'add_checkpoint', { location: 'X', kind: 'Milestone', evidence: H });
      break;
    case Status.Disputed:
      t.call('consignee', 'raise_dispute');
      break;
    case Status.Released:
      t.call('consignee', 'confirm_delivery', { evidence: H });
      break;
    case Status.Resolved:
      t.call('consignee', 'raise_dispute');
      t.call('arbiter', 'vote', { payCarrierPct: 50n });
      t.call('arbiter2', 'vote', { payCarrierPct: 50n });
      break;
    case Status.Refunded:
      t.chain.advanceKeyblocks(DEADLINE_IN + 1);
      t.call('shipper', 'refund_after_deadline');
      break;
    default:
      throw new Error(`unknown status ${target}`);
  }
  return t;
}

// Conservation: every terminal state has paid out exactly `amount` and holds nothing.
function assertConserved({ chain, id, amount }) {
  const paid = chain.events(id).filter((e) => e.type === 'Paid').reduce((sum, e) => sum + e.amount, 0n);
  const st = chain.contractState(id).status;
  if (TERMINAL.has(st)) {
    assert.equal(paid, amount, 'terminal: paid == funded');
    assert.equal(chain.balanceOf(id), 0n, 'terminal: escrow empty');
  } else if (st !== Status.Created) {
    const { paidOut } = chain.contractState(id);
    assert.equal(chain.balanceOf(id), amount - paidOut, 'open: escrow holds funded minus milestones paid');
    assert.equal(paid, paidOut, 'open: Paid events match paidOut');
  }
}

describe('init', () => {
  // A fresh shipper and payee per deploy, with an agreed quote for `price`.
  function deployFor(price, overrides = {}) {
    const chain = new SimChain();
    const shipper = chain.createAccount('s', 0n);
    const carrier = chain.createAccount('c', 0n);
    const terms = { price, schedule: [] };
    const quote = agreeQuote(chain, shipper, carrier, terms);
    const args = { carrier, consignee: chain.createAccount('k', 0n), attestors: [], panel: ['ak_demo_arbiter_x'], quorum: 1, window: 1, quote, terms, deadline: chain.keyHeight + 1, ...overrides(chain) };
    return () => chain.deploy(ShipmentEscrow, shipper, args);
  }
  const none = () => ({});
  for (const [label, amount, code] of [['zero', 0n, 'BAD_AMOUNT'], ['negative', -1n, 'BAD_AMOUNT'], ['number not bigint', 5, 'BAD_AMOUNT']]) {
    test(`rejects ${label} amount (${code})`, () => {
      assert.throws(deployFor(amount, none), { code });
    });
  }
  test('accepts the smallest amount (1)', () => {
    assert.doesNotThrow(deployFor(1n, none));
  });
  test('rejects deadline at current height (BAD_DEADLINE), accepts height + 1', () => {
    assert.throws(deployFor(1n, (chain) => ({ deadline: chain.keyHeight })), { code: 'BAD_DEADLINE' });
    assert.doesNotThrow(deployFor(1n, (chain) => ({ deadline: chain.keyHeight + 1 })));
  });
});

describe('role matrix: only the listed roles may call each entrypoint', () => {
  const cases = [
    { ep: 'fund', from: Status.Created, allowed: ['shipper'], denied: 'ONLY_SHIPPER', value: AMOUNT },
    { ep: 'add_checkpoint', from: Status.Funded, allowed: ['carrier', 'attestor'], denied: 'UNAUTHORIZED', args: { location: 'X', kind: 'Milestone', evidence: H } },
    { ep: 'confirm_delivery', from: Status.InTransit, allowed: ['consignee', 'attestor'], denied: 'UNAUTHORIZED', args: { evidence: H } },
    { ep: 'raise_dispute', from: Status.InTransit, allowed: ['shipper', 'carrier', 'consignee'], denied: 'UNAUTHORIZED' },
    { ep: 'vote', from: Status.Disputed, allowed: ARBITERS, denied: 'ONLY_ARBITER', args: { payCarrierPct: 50n } },
    { ep: 'resolve_by_fallback', from: Status.Disputed, after: WINDOW + 1, allowed: ['shipper', 'carrier', 'consignee', ...ARBITERS], denied: 'UNAUTHORIZED' },
  ];
  for (const c of cases) {
    for (const role of ROLES) {
      const ok = c.allowed.includes(role);
      test(`${c.ep} by ${role} → ${ok ? 'accepted' : c.denied}`, () => {
        const t = inStatus(c.from);
        if (c.after) t.chain.advanceKeyblocks(c.after);
        const run = () => t.call(role, c.ep, c.args, c.value ?? 0n);
        if (ok) assert.doesNotThrow(run);
        else assert.throws(run, { code: c.denied });
        assertConserved(t);
      });
    }
  }
  test('refund_after_deadline by non-shipper → ONLY_SHIPPER', () => {
    for (const role of ROLES.filter((r) => r !== 'shipper')) {
      const t = inStatus(Status.Funded);
      t.chain.advanceKeyblocks(DEADLINE_IN + 1);
      assert.throws(() => t.call(role, 'refund_after_deadline'), { code: 'ONLY_SHIPPER' });
    }
  });
});

describe('status matrix: each entrypoint is rejected in every status it does not allow', () => {
  const all = Object.values(Status);
  const cases = [
    { ep: 'fund', role: 'shipper', ok: [Status.Created], value: AMOUNT },
    { ep: 'add_checkpoint', role: 'carrier', ok: [Status.Funded, Status.InTransit], args: { location: 'X', kind: 'Milestone', evidence: H } },
    { ep: 'confirm_delivery', role: 'consignee', ok: [Status.Funded, Status.InTransit], args: { evidence: H } },
    { ep: 'raise_dispute', role: 'shipper', ok: [Status.Funded, Status.InTransit] },
    { ep: 'vote', role: 'arbiter', ok: [Status.Disputed], args: { payCarrierPct: 50n } },
    { ep: 'resolve_by_fallback', role: 'consignee', ok: [Status.Disputed], expire: true },
    { ep: 'refund_after_deadline', role: 'shipper', ok: [Status.Funded, Status.InTransit], expire: true },
  ];
  for (const c of cases) {
    for (const st of all) {
      const ok = c.ok.includes(st);
      test(`${c.ep} in ${st} → ${ok ? 'accepted' : 'BAD_STATE'}`, () => {
        const t = inStatus(st);
        if (c.expire) t.chain.advanceKeyblocks(DEADLINE_IN + 1);
        const run = () => t.call(c.role, c.ep, c.args, c.value ?? 0n);
        if (ok) assert.doesNotThrow(run);
        else assert.throws(run, { code: 'BAD_STATE' });
        assertConserved(t);
      });
    }
  }
});

describe('funding amount boundaries', () => {
  for (const [label, value, code] of [['zero', 0n, 'WRONG_AMOUNT'], ['amount - 1', AMOUNT - 1n, 'WRONG_AMOUNT'], ['amount + 1', AMOUNT + 1n, 'WRONG_AMOUNT']]) {
    test(`rejects ${label} (${code}) and returns the funds`, () => {
      const t = setup();
      const before = t.chain.balanceOf(t.a.shipper);
      assert.throws(() => t.call('shipper', 'fund', {}, value), { code });
      assert.equal(t.chain.balanceOf(t.a.shipper), before);
      assert.equal(t.chain.balanceOf(t.id), 0n);
    });
  }
  test('accepts exact amount', () => {
    const t = setup();
    t.call('shipper', 'fund', {}, AMOUNT);
    assert.equal(t.status(), Status.Funded);
    assert.equal(t.chain.balanceOf(t.id), AMOUNT);
  });
  test('value sent to a non-payable entrypoint is rejected (NOT_PAYABLE)', () => {
    const t = inStatus(Status.Funded);
    assert.throws(() => t.call('carrier', 'add_checkpoint', { location: 'X', kind: 'Milestone', evidence: H }, 1n), { code: 'NOT_PAYABLE' });
  });
});

describe('deadline boundaries', () => {
  test('refund at deadline height is rejected (NOT_EXPIRED)', () => {
    const t = inStatus(Status.Funded);
    t.chain.advanceKeyblocks(DEADLINE_IN);
    assert.throws(() => t.call('shipper', 'refund_after_deadline'), { code: 'NOT_EXPIRED' });
  });
  test('refund one block after deadline is accepted', () => {
    const t = inStatus(Status.Funded);
    t.chain.advanceKeyblocks(DEADLINE_IN + 1);
    t.call('shipper', 'refund_after_deadline');
    assert.equal(t.status(), Status.Refunded);
    assertConserved(t);
  });
  test('delivery after the deadline is still accepted while unrefunded', () => {
    const t = inStatus(Status.InTransit);
    t.chain.advanceKeyblocks(DEADLINE_IN * 5);
    t.call('attestor', 'confirm_delivery', { evidence: H });
    assert.equal(t.status(), Status.Released);
  });
});

describe('dispute split boundaries', () => {
  for (const pct of [-1n, 101n, 50]) {
    test(`rejects payCarrierPct=${pct} (${typeof pct}) with BAD_SPLIT`, () => {
      const t = inStatus(Status.Disputed);
      assert.throws(() => t.call('arbiter', 'vote', { payCarrierPct: pct }), { code: 'BAD_SPLIT' });
    });
  }
  for (const pct of [0n, 1n, 33n, 99n, 100n]) {
    for (const amount of [1n, 7n, AMOUNT]) {
      test(`split ${pct}% of ${amount} conserves funds (remainder to shipper)`, () => {
        const t = setup({ amount });
        t.call('shipper', 'fund', {}, amount);
        t.call('consignee', 'raise_dispute');
        const carrier0 = t.chain.balanceOf(t.a.carrier);
        t.call('arbiter', 'vote', { payCarrierPct: pct });
        t.call('arbiter3', 'vote', { payCarrierPct: pct });
        assert.equal(t.chain.balanceOf(t.a.carrier) - carrier0, (amount * pct) / 100n);
        assertConserved(t);
      });
    }
  }
});

describe('checkpoint kinds and manifest (ADR 0003)', () => {
  for (const kind of ['Milestone', 'ScanIn', 'ScanOut']) {
    test(`accepts kind ${kind} and records it on the checkpoint`, () => {
      const t = inStatus(Status.Funded);
      t.call('attestor', 'add_checkpoint', { location: 'Yantian', kind, evidence: H });
      assert.equal(t.chain.contractState(t.id).checkpoints.at(-1).kind, kind);
    });
  }
  for (const kind of ['Delivered', undefined, 'Teleported', 'scanin']) {
    test(`rejects kind ${kind} (BAD_KIND)`, () => {
      const t = inStatus(Status.Funded);
      assert.throws(() => t.call('carrier', 'add_checkpoint', { location: 'X', kind, evidence: H }), { code: 'BAD_KIND' });
    });
  }
  test('kind is checked after role and status', () => {
    const t = inStatus(Status.Released);
    assert.throws(() => t.call('stranger', 'add_checkpoint', { location: 'X', kind: 'Delivered', evidence: H }), { code: 'UNAUTHORIZED' });
    assert.throws(() => t.call('carrier', 'add_checkpoint', { location: 'X', kind: 'Delivered', evidence: H }), { code: 'BAD_STATE' });
  });
  test('confirm_delivery records a Delivered checkpoint', () => {
    const t = inStatus(Status.Released);
    assert.equal(t.chain.contractState(t.id).checkpoints.at(-1).kind, 'Delivered');
  });
  test('the manifest hash is stored as booked', () => {
    const t = setup({ manifest: 'b'.repeat(64) });
    assert.equal(t.chain.contractState(t.id).manifest, 'b'.repeat(64));
  });
});

describe('created only from an agreed quote (ADR 0004)', () => {
  function attempt(mutate) {
    const chain = new SimChain();
    const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
    const terms = { price: AMOUNT, schedule: [['Yantian', 20]] };
    const ctx = { chain, a, terms, quote: agreeQuote(chain, a.shipper, a.carrier, terms), caller: a.shipper, carrier: a.carrier };
    mutate?.(ctx);
    return () =>
      chain.deploy(ShipmentEscrow, ctx.caller, {
        carrier: ctx.carrier, consignee: a.consignee, attestors: [], panel: [a.arbiter], quorum: 1, window: 1,
        quote: ctx.quote, terms: ctx.terms, deadline: chain.keyHeight + DEADLINE_IN,
      });
  }
  test('accepts the agreed terms', () => {
    assert.doesNotThrow(attempt());
  });
  test('rejects a quote that is still open (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.quote = c.chain.deploy(QuoteRequest, c.a.shipper, { invited: [c.a.carrier], job: 'j' }).result; }), { code: 'NOT_AGREED' });
  });
  test('rejects a withdrawn quote (NOT_AGREED)', () => {
    assert.throws(attempt((c) => {
      c.quote = c.chain.deploy(QuoteRequest, c.a.shipper, { invited: [c.a.carrier], job: 'j' }).result;
      c.chain.call(c.quote, 'withdraw', {}, { caller: c.a.shipper });
    }), { code: 'NOT_AGREED' });
  });
  test('rejects different terms: price changed (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.terms = { ...c.terms, price: AMOUNT - 1n }; }), { code: 'NOT_AGREED' });
  });
  test('rejects different terms: schedule changed (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.terms = { ...c.terms, schedule: [['Yantian', 21]] }; }), { code: 'NOT_AGREED' });
  });
  test('rejects a payee who is not the agreed counterparty (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.carrier = c.a.stranger; }), { code: 'NOT_AGREED' });
  });
  test('rejects anyone but the requester creating the escrow (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.caller = c.a.stranger; }), { code: 'NOT_AGREED' });
  });
  test('the agreement is checked before anything else', () => {
    assert.throws(attempt((c) => { c.carrier = c.a.stranger; c.terms = { price: 0n, schedule: [['X', 0]] }; }), { code: 'NOT_AGREED' });
  });
});

describe('milestone schedule (ADR 0004)', () => {
  for (const [label, schedule] of [
    ['a 0% milestone', [['A', 0]]],
    ['a 101% milestone', [['A', 101]]],
    ['a total of 101%', [['A', 60], ['B', 41]]],
    ['duplicate locations', [['A', 10], ['A', 10]]],
    ['a fractional %', [['A', 1.5]]],
    ['not a list', 'A:20'],
  ]) {
    test(`rejects ${label} (BAD_SCHEDULE)`, () => {
      assert.throws(() => setup({ schedule }), { code: 'BAD_SCHEDULE' });
    });
  }
  for (const [label, schedule] of [['an empty schedule', []], ['a total of exactly 100%', [['A', 40], ['B', 60]]], ['a 1% milestone', [['A', 1]]]]) {
    test(`accepts ${label}`, () => assert.doesNotThrow(() => setup({ schedule })));
  }

  const funded = (schedule, amount = AMOUNT) => {
    const t = setup({ schedule, amount });
    t.call('shipper', 'fund', {}, amount);
    return t;
  };
  const payeeGets = (t, fn) => {
    const before = t.chain.balanceOf(t.a.carrier);
    fn();
    return t.chain.balanceOf(t.a.carrier) - before;
  };
  const scanIn = (t, role, location) => t.call(role, 'add_checkpoint', { location, kind: 'ScanIn', evidence: H });

  test("an attestor's scan-in at the location pays the milestone", () => {
    const t = funded([['Yantian', 20]]);
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'Yantian')), 200n);
    assertConserved(t);
  });
  test('a milestone pays only once', () => {
    const t = funded([['Yantian', 20]]);
    scanIn(t, 'attestor', 'Yantian');
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'Yantian')), 0n);
  });
  test("the payee's own scan-in never pays a milestone", () => {
    const t = funded([['Yantian', 20]]);
    assert.equal(payeeGets(t, () => scanIn(t, 'carrier', 'Yantian')), 0n);
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'Yantian')), 200n);
  });
  test('scan-outs, milestones and other locations pay nothing', () => {
    const t = funded([['Yantian', 20]]);
    const paid = payeeGets(t, () => {
      t.call('attestor', 'add_checkpoint', { location: 'Yantian', kind: 'ScanOut', evidence: H });
      t.call('attestor', 'add_checkpoint', { location: 'Yantian', kind: 'Milestone', evidence: H });
      scanIn(t, 'attestor', 'Singapore');
    });
    assert.equal(paid, 0n);
  });
  test('delivery pays the remainder after milestones', () => {
    const t = funded([['Yantian', 20], ['Rotterdam', 50]]);
    scanIn(t, 'attestor', 'Yantian');
    scanIn(t, 'attestor', 'Rotterdam');
    assert.equal(payeeGets(t, () => t.call('consignee', 'confirm_delivery', { evidence: H })), 300n);
    assertConserved(t);
  });
  test('a 100% schedule leaves nothing for delivery, and delivery still settles', () => {
    const t = funded([['A', 100]]);
    scanIn(t, 'attestor', 'A');
    assert.equal(payeeGets(t, () => t.call('consignee', 'confirm_delivery', { evidence: H })), 0n);
    assert.equal(t.status(), Status.Released);
    assertConserved(t);
  });
  test('a dispute splits only the unpaid remainder; paid milestones stand', () => {
    const t = funded([['Yantian', 20]]);
    scanIn(t, 'attestor', 'Yantian'); // 200 paid
    t.call('consignee', 'raise_dispute');
    t.call('arbiter', 'vote', { payCarrierPct: 50n });
    const toPayee = payeeGets(t, () => t.call('arbiter2', 'vote', { payCarrierPct: 50n }));
    assert.equal(toPayee, 400n); // 50% of the remaining 800
    assertConserved(t);
  });
  test('a refund returns only the unpaid remainder', () => {
    const t = funded([['Yantian', 20]]);
    scanIn(t, 'attestor', 'Yantian');
    t.chain.advanceKeyblocks(DEADLINE_IN + 1);
    const before = t.chain.balanceOf(t.a.shipper);
    t.call('shipper', 'refund_after_deadline');
    assert.equal(t.chain.balanceOf(t.a.shipper) - before, 800n);
    assertConserved(t);
  });
  test('rounding: 33% of 7 pays 2 and delivery pays the other 5', () => {
    const t = funded([['A', 33]], 7n);
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'A')), 2n);
    assert.equal(payeeGets(t, () => t.call('consignee', 'confirm_delivery', { evidence: H })), 5n);
    assertConserved(t);
  });
});

describe('arbiter panel (ADR 0002)', () => {
  // Deploys with a custom panel config; returns the deploy thunk so callers can assert errors.
  function deployWith(overrides) {
    const chain = new SimChain();
    const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
    const args = {
      carrier: a.carrier,
      consignee: a.consignee,
      attestors: [],
      panel: ARBITERS.map((r) => a[r]),
      quorum: QUORUM,
      window: WINDOW,
      deadline: chain.keyHeight + DEADLINE_IN,
      ...overrides(a),
    };
    args.terms ??= { price: AMOUNT, schedule: [] };
    args.quote ??= agreeQuote(chain, a.shipper, args.carrier, args.terms);
    return () => chain.deploy(ShipmentEscrow, a.shipper, args);
  }
  const disputed = (opts) => {
    const t = setup(opts);
    t.call('shipper', 'fund', {}, AMOUNT);
    t.call('consignee', 'raise_dispute');
    return t;
  };

  for (const [label, quorum] of [['0', 0], ['N + 1', 4], ['-1', -1], ['fractional', 1.5]]) {
    test(`rejects quorum ${label} (BAD_QUORUM)`, () => {
      assert.throws(deployWith(() => ({ quorum })), { code: 'BAD_QUORUM' });
    });
  }
  for (const quorum of [1, 3]) {
    test(`accepts quorum ${quorum} of 3`, () => assert.doesNotThrow(deployWith(() => ({ quorum }))));
  }
  test('panel size boundary: 7 arbiters accepted, 8 rejected (BAD_QUORUM)', () => {
    const many = (n) => (a) => ({ panel: Array.from({ length: n }, (_, i) => `ak_demo_arb_extra_${i}`), quorum: 1 });
    assert.doesNotThrow(deployWith(many(7)));
    assert.throws(deployWith(many(8)), { code: 'BAD_QUORUM' });
  });
  test('rejects an empty panel and duplicate arbiters (BAD_QUORUM)', () => {
    assert.throws(deployWith(() => ({ panel: [], quorum: 1 })), { code: 'BAD_QUORUM' });
    assert.throws(deployWith((a) => ({ panel: [a.arbiter, a.arbiter], quorum: 2 })), { code: 'BAD_QUORUM' });
  });
  for (const party of ['shipper', 'carrier', 'consignee']) {
    test(`rejects the ${party} on the panel (CONFLICTED_ARBITER)`, () => {
      assert.throws(deployWith((a) => ({ panel: [a.arbiter, a[party]] })), { code: 'CONFLICTED_ARBITER' });
    });
  }
  test('rejects a zero arbitration window (BAD_DEADLINE) and fallback outside 0..100 (BAD_SPLIT)', () => {
    assert.throws(deployWith(() => ({ window: 0 })), { code: 'BAD_DEADLINE' });
    assert.throws(deployWith(() => ({ fallback: -1n })), { code: 'BAD_SPLIT' });
    assert.throws(deployWith(() => ({ fallback: 101n })), { code: 'BAD_SPLIT' });
  });

  test('one vote below quorum does not settle', () => {
    const t = disputed();
    t.call('arbiter', 'vote', { payCarrierPct: 60n });
    assert.equal(t.status(), Status.Disputed);
    assertConserved(t);
  });
  test('mismatched votes do not settle; a changed vote that matches does', () => {
    const t = disputed();
    t.call('arbiter', 'vote', { payCarrierPct: 60n });
    t.call('arbiter2', 'vote', { payCarrierPct: 40n });
    assert.equal(t.status(), Status.Disputed);
    t.call('arbiter2', 'vote', { payCarrierPct: 60n });
    assert.equal(t.status(), Status.Resolved);
    assertConserved(t);
  });
  test('an arbiter re-voting the same split counts once', () => {
    const t = disputed();
    t.call('arbiter', 'vote', { payCarrierPct: 60n });
    t.call('arbiter', 'vote', { payCarrierPct: 60n });
    assert.equal(t.status(), Status.Disputed);
  });
  test('quorum 1 settles on the first vote; quorum 3 needs every arbiter', () => {
    const one = disputed({ quorum: 1 });
    one.call('arbiter3', 'vote', { payCarrierPct: 0n });
    assert.equal(one.status(), Status.Resolved);
    const all = disputed({ quorum: 3 });
    all.call('arbiter', 'vote', { payCarrierPct: 70n });
    all.call('arbiter2', 'vote', { payCarrierPct: 70n });
    assert.equal(all.status(), Status.Disputed);
    all.call('arbiter3', 'vote', { payCarrierPct: 70n });
    assert.equal(all.status(), Status.Resolved);
  });

  test('fallback is rejected at the window edge (ARBITRATION_OPEN) and allowed one block after', () => {
    const t = disputed();
    t.chain.advanceKeyblocks(WINDOW);
    assert.throws(() => t.call('carrier', 'resolve_by_fallback'), { code: 'ARBITRATION_OPEN' });
    t.chain.advanceKeyblocks(1);
    t.call('carrier', 'resolve_by_fallback');
    assert.equal(t.status(), Status.Resolved);
    assertConserved(t);
  });
  test('fallback applies the default 50% split', () => {
    const t = disputed();
    const carrier0 = t.chain.balanceOf(t.a.carrier);
    t.chain.advanceKeyblocks(WINDOW + 1);
    t.call('shipper', 'resolve_by_fallback');
    assert.equal(t.chain.balanceOf(t.a.carrier) - carrier0, AMOUNT / 2n);
  });
  test('fallback applies a custom split agreed at booking', () => {
    const t = disputed({ fallback: 20n });
    const carrier0 = t.chain.balanceOf(t.a.carrier);
    t.chain.advanceKeyblocks(WINDOW + 1);
    t.call('arbiter2', 'resolve_by_fallback');
    assert.equal(t.chain.balanceOf(t.a.carrier) - carrier0, (AMOUNT * 20n) / 100n);
    assertConserved(t);
  });
  test('the window counts from the dispute, not from booking', () => {
    const t = setup();
    t.call('shipper', 'fund', {}, AMOUNT);
    t.chain.advanceKeyblocks(WINDOW * 3);
    t.call('consignee', 'raise_dispute');
    assert.throws(() => t.call('carrier', 'resolve_by_fallback'), { code: 'ARBITRATION_OPEN' });
  });
  test('late votes still settle the dispute before anyone calls the fallback', () => {
    const t = disputed();
    t.chain.advanceKeyblocks(WINDOW + 10);
    t.call('arbiter', 'vote', { payCarrierPct: 80n });
    t.call('arbiter3', 'vote', { payCarrierPct: 80n });
    assert.equal(t.status(), Status.Resolved);
  });
  test('the attestor and strangers cannot trigger the fallback (UNAUTHORIZED)', () => {
    const t = disputed();
    t.chain.advanceKeyblocks(WINDOW + 1);
    for (const role of ['attestor', 'stranger']) {
      assert.throws(() => t.call(role, 'resolve_by_fallback'), { code: 'UNAUTHORIZED' });
    }
  });
});

describe('repeats cannot double-pay', () => {
  test('second confirm_delivery is BAD_STATE', () => {
    const t = inStatus(Status.Released);
    assert.throws(() => t.call('attestor', 'confirm_delivery', { evidence: H }), { code: 'BAD_STATE' });
    assertConserved(t);
  });
  test('votes and fallback after resolution are BAD_STATE', () => {
    const t = inStatus(Status.Resolved);
    assert.throws(() => t.call('arbiter3', 'vote', { payCarrierPct: 100n }), { code: 'BAD_STATE' });
    t.chain.advanceKeyblocks(WINDOW + 1);
    assert.throws(() => t.call('shipper', 'resolve_by_fallback'), { code: 'BAD_STATE' });
    assertConserved(t);
  });
  test('second fund is BAD_STATE', () => {
    const t = inStatus(Status.Funded);
    assert.throws(() => t.call('shipper', 'fund', {}, AMOUNT), { code: 'BAD_STATE' });
  });
});

test('checks run in order role → status → args', () => {
  const t = inStatus(Status.Released);
  // stranger, wrong status, bad split: role error wins
  assert.throws(() => t.call('stranger', 'vote', { payCarrierPct: 999n }), { code: 'ONLY_ARBITER' });
  // arbiter, wrong status, bad split: status error wins
  assert.throws(() => t.call('arbiter', 'vote', { payCarrierPct: 999n }), { code: 'BAD_STATE' });
});

test('property: random call sequences conserve funds and never leave a terminal state (seeded)', () => {
  const seed = 0x6a6a;
  let x = seed;
  const rand = (n) => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x % n);
  const eps = [
    ['fund', () => ({}), () => [0n, AMOUNT, AMOUNT - 1n][rand(3)]],
    ['add_checkpoint', () => ({ location: 'X', kind: 'Milestone', evidence: H })],
    ['confirm_delivery', () => ({ evidence: H })],
    ['raise_dispute', () => ({})],
    ['vote', () => ({ payCarrierPct: [-1n, 0n, 50n, 100n, 101n][rand(5)] })], // few values, so quorums happen
    ['add_checkpoint', () => ({ location: ['A', 'B', 'C'][rand(3)], kind: ['ScanIn', 'ScanOut'][rand(2)], evidence: H })],
    ['resolve_by_fallback', () => ({})],
    ['refund_after_deadline', () => ({})],
  ];
  for (let run = 0; run < 300; run++) {
    const t = setup({ schedule: [['A', 20], ['B', 30]] });
    const supply = t.chain.totalSupply();
    let terminal = null;
    for (let i = 0; i < 12; i++) {
      if (rand(4) === 0) t.chain.advanceKeyblocks(rand(DEADLINE_IN));
      const [ep, args, value] = eps[rand(eps.length)];
      try {
        t.call(ROLES[rand(ROLES.length)], ep, args(), value ? value() : 0n);
      } catch (e) {
        assert.ok(e.code, `seed=${seed} run=${run}: non-contract error ${e}`);
      }
      const st = t.status();
      if (terminal) assert.equal(st, terminal, `seed=${seed} run=${run}: left terminal state`);
      if (TERMINAL.has(st)) terminal = st;
      assertConserved(t);
      assert.equal(t.chain.totalSupply(), supply);
    }
  }
});
