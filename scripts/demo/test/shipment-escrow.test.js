import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { escrowFor, feeDue, Status, TERMINAL } from '../lib/shipment-escrow.js';
import { QuoteRequest, jobHash, termsHash } from '../lib/quote-request.js';
import { Platform } from '../lib/platform.js';
import { CONSIGNMENT } from '../lib/fixtures.js';

const AMOUNT = 1_000n;
const DEADLINE_IN = 10;
const WINDOW = 5; // arbitration window, in blocks
const QUORUM = 2; // of a three-arbiter panel
const H = 'a'.repeat(64);
const ARBITERS = ['arbiter', 'arbiter2', 'arbiter3'];
const ROLES = ['shipper', 'carrier', 'consignee', 'attestor', ...ARBITERS, 'stranger'];
const TREASURY = 'ak_demo_treasury';
// Most tests check exact payouts, so fees are off unless a test turns them on (ADR 0010).
const NO_FEE = { bps: 0, min: 0n };
const CHALLENGE = 720;

// The request's dispute terms, and the full terms a quote carries (ADR 0011, ADR 0015):
// the booking's panel, quorum, window and fallback, its deadline, plus price and schedule.
const disputeOf = (args) => ({ panel: args.panel, quorum: args.quorum, window: args.window, fallback: Number(args.fallback ?? 50n), challenge: CHALLENGE });
const withFullTerms = (args) => ({ ...args, terms: { ...args.terms, attestors: args.attestors, deadline: args.deadline, ...disputeOf(args) } });

// Sole admin (quorum 1), so each proposal applies at once.
function setFee(chain, platform, admin, { bps, min }) {
  chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'fee_bps', value: bps } }, { caller: admin });
  chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'min_fee', value: min } }, { caller: admin });
}

// Agrees terms through a registered QuoteRequest for exactly this job, so every escrow
// passes the UNKNOWN_QUOTE and NOT_AGREED gates (ADR 0004, ADR 0005).
function agreeQuote(chain, requester, payee, terms, job, fee, dispute) {
  const { result: platform } = chain.deploy(Platform, requester, { admins: [requester], quorum: 1, treasury: TREASURY });
  setFee(chain, platform, requester, fee);
  const { result: quote } = chain.call(platform, 'new_quote', { invited: [payee], job, consignment: CONSIGNMENT, dispute }, { caller: requester });
  chain.call(quote, 'quote', { terms, validUntil: chain.keyHeight + 100 }, { caller: payee });
  chain.call(quote, 'accept', { invitee: payee, terms: termsHash(terms) }, { caller: requester });
  return { platform, quote };
}

const fundingFor = (price) => (typeof price === 'bigint' && price > 0n ? price : 0n);

// Agrees a quote for `args` (unless one is given) and creates + funds the escrow in one call.
function bookEscrow(chain, shipper, given, { value = fundingFor(given.terms.price), quote, platform, fee } = {}) {
  const args = withFullTerms(given);
  const agreed = quote ? { quote, platform } : agreeQuote(chain, shipper, args.carrier, args.terms, jobHash(args), fee ?? NO_FEE, disputeOf(args));
  // The escrow template is bound to its network's canonical platform (ADR 0005).
  return chain.deploy(escrowFor(agreed.platform), shipper, { ...args, quote: agreed.quote }, { value });
}

function setup({ amount = AMOUNT, quorum = QUORUM, fallback, manifest = 'c'.repeat(64), schedule = [], fee } = {}) {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
  const { result: id } = bookEscrow(chain, a.shipper, {
    carrier: a.carrier,
    consignee: a.consignee,
    attestors: [a.attestor],
    panel: ARBITERS.map((r) => a[r]),
    quorum,
    window: WINDOW,
    fallback,
    manifest,
    terms: { price: amount, schedule },
    deadline: chain.keyHeight + DEADLINE_IN,
  }, { fee });
  const call = (role, ep, args = {}, value = 0n) => chain.call(id, ep, args, { caller: a[role], value });
  const status = () => chain.contractState(id).status;
  return { chain, a, id, call, status, amount };
}

// Drive a fresh contract into the given status.
function inStatus(target) {
  const t = setup(); // created and funded in one call
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

// Conservation: every terminal state has paid out exactly `amount` (payee, treasury and
// shipper together) and holds nothing. The fee is always exactly what's due on the payee's gross.
function assertConserved({ chain, id, amount }) {
  const paid = chain.events(id).filter((e) => e.type === 'Paid').reduce((sum, e) => sum + e.amount, 0n);
  const s = chain.contractState(id);
  const fees = chain.events(id).filter((e) => e.type === 'FeePaid').reduce((sum, e) => sum + e.amount, 0n);
  assert.equal(fees, feeDue(s, s.toPayee), 'fee paid == fee due on the payee gross');
  assert.equal(fees, s.feePaid, 'FeePaid events match feePaid');
  const st = chain.contractState(id).status;
  if (TERMINAL.has(st)) {
    assert.equal(paid, amount, 'terminal: paid == funded');
    assert.equal(chain.balanceOf(id), 0n, 'terminal: escrow empty');
  } else {
    const { paidOut } = chain.contractState(id);
    assert.equal(chain.balanceOf(id), amount - paidOut, 'open: escrow holds funded minus milestones paid');
    assert.equal(paid, paidOut, 'open: Paid events match paidOut');
  }
}

describe('init', () => {
  // A fresh shipper and payee per deploy, with an agreed quote for `price`.
  function deployFor(price, overrides = {}) {
    const chain = new SimChain();
    const shipper = chain.createAccount('s', 10_000n);
    const carrier = chain.createAccount('c', 0n);
    const args = { carrier, consignee: chain.createAccount('k', 0n), attestors: [], panel: ['ak_demo_arbiter_x'], quorum: 1, window: 1, terms: { price, schedule: [] }, deadline: chain.keyHeight + 1, ...overrides(chain) };
    return () => bookEscrow(chain, shipper, args);
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

describe('funding at creation (ADR 0005)', () => {
  // The quote is agreed first, so only the value sent with the booking varies.
  function bookWith(value) {
    const chain = new SimChain();
    const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
    const args = withFullTerms({ carrier: a.carrier, consignee: a.consignee, attestors: [], panel: [a.arbiter], quorum: 1, window: 1, terms: { price: AMOUNT, schedule: [] }, deadline: chain.keyHeight + DEADLINE_IN });
    const agreed = agreeQuote(chain, a.shipper, a.carrier, args.terms, jobHash(args), NO_FEE, disputeOf(args));
    return { chain, a, run: () => bookEscrow(chain, a.shipper, args, { ...agreed, value }) };
  }
  for (const [label, value] of [['zero', 0n], ['amount - 1', AMOUNT - 1n], ['amount + 1', AMOUNT + 1n]]) {
    test(`rejects ${label} (WRONG_AMOUNT) and returns the funds`, () => {
      const { chain, a, run } = bookWith(value);
      const before = chain.balanceOf(a.shipper);
      assert.throws(run, { code: 'WRONG_AMOUNT' });
      assert.equal(chain.balanceOf(a.shipper), before);
    });
  }
  test('the exact price creates a Funded escrow holding it, in one call', () => {
    const { chain, run } = bookWith(AMOUNT);
    const { result: id } = run();
    assert.equal(chain.contractState(id).status, Status.Funded);
    assert.equal(chain.balanceOf(id), AMOUNT);
  });
  test('there is no separate fund step (UNKNOWN_ENTRYPOINT)', () => {
    const t = setup();
    assert.throws(() => t.call('shipper', 'fund', {}, AMOUNT), { code: 'UNKNOWN_ENTRYPOINT' });
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

describe('created only from a registered, agreed quote (ADR 0004, ADR 0005)', () => {
  // Agrees a registered quote for the canonical args; `mutate` then changes what is booked.
  function attempt(mutate) {
    const chain = new SimChain();
    const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
    const args = withFullTerms({ carrier: a.carrier, consignee: a.consignee, attestors: [], panel: [a.arbiter], quorum: 1, window: 1, manifest: 'm'.repeat(64), terms: { price: AMOUNT, schedule: [['Yantian', 20]] }, deadline: chain.keyHeight + DEADLINE_IN });
    const agreed = agreeQuote(chain, a.shipper, a.carrier, args.terms, jobHash(args), NO_FEE, disputeOf(args));
    const c = { chain, a, args: { ...args }, caller: a.shipper, ...agreed };
    mutate?.(c);
    return () => chain.deploy(escrowFor(c.platform), c.caller, { ...c.args, quote: c.quote }, { value: fundingFor(c.args.terms.price) });
  }
  test('accepts the agreed terms', () => {
    assert.doesNotThrow(attempt());
  });
  test('rejects a quote that is still open (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.quote = c.chain.call(c.platform, 'new_quote', { invited: [c.a.carrier], job: jobHash(c.args), consignment: CONSIGNMENT, dispute: disputeOf(c.args) }, { caller: c.a.shipper }).result; }), { code: 'NOT_AGREED' });
  });
  test('rejects a withdrawn quote (NOT_AGREED)', () => {
    assert.throws(attempt((c) => {
      c.quote = c.chain.call(c.platform, 'new_quote', { invited: [c.a.carrier], job: jobHash(c.args), consignment: CONSIGNMENT, dispute: disputeOf(c.args) }, { caller: c.a.shipper }).result;
      c.chain.call(c.quote, 'withdraw', {}, { caller: c.a.shipper });
    }), { code: 'NOT_AGREED' });
  });
  test('rejects different terms: price changed (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.args.terms = { ...c.args.terms, price: AMOUNT - 1n }; }), { code: 'NOT_AGREED' });
  });
  test('rejects different terms: schedule changed (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.args.terms = { ...c.args.terms, schedule: [['Yantian', 21]] }; }), { code: 'NOT_AGREED' });
  });
  test('rejects a payee who is not the agreed counterparty (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.args.carrier = c.a.stranger; }), { code: 'NOT_AGREED' });
  });
  test('rejects anyone but the requester creating the escrow (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.caller = c.a.stranger; }), { code: 'NOT_AGREED' });
  });
  for (const [label, mutate] of [
    ['a different manifest', (c) => { c.args.manifest = 'n'.repeat(64); }],
    ['a different consignee', (c) => { c.args.consignee = c.a.stranger; }],
  ]) {
    test(`rejects an agreed quote reused for ${label} (NOT_AGREED)`, () => {
      assert.throws(attempt(mutate), { code: 'NOT_AGREED' });
    });
  }
  // ADR 0011: the escrow reads every term from the agreed quote; nothing at booking can change them.
  test('rejects a deadline other than the agreed one (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.args.terms = { ...c.args.terms, deadline: c.args.terms.deadline + 1 }; }), { code: 'NOT_AGREED' });
  });
  test('rejects attestors other than the agreed ones (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.args.terms = { ...c.args.terms, attestors: [c.a.stranger] }; }), { code: 'NOT_AGREED' });
  });
  test('takes attestors, panel and deadline from the agreed terms, ignoring anything passed beside them', () => {
    const c = {};
    const run = attempt((x) => {
      Object.assign(c, x);
      x.args = { ...x.args, attestors: [x.a.stranger], panel: [x.a.stranger], quorum: 1, deadline: x.args.deadline + 99 };
    });
    const { result: id } = run();
    const s = c.chain.contractState(id);
    assert.deepEqual(s.attestors, c.args.terms.attestors);
    assert.deepEqual(s.arbiters, c.args.terms.panel);
    assert.equal(s.deadline, c.args.terms.deadline);
  });
  test('the job is the manifest and consignee only, so the forwarder may choose the deadline', () => {
    assert.equal(jobHash({ manifest: 'm', consignee: 'c', deadline: 1 }), jobHash({ manifest: 'm', consignee: 'c', deadline: 2 }));
  });
  test('rejects a look-alike quote the platform never registered (UNKNOWN_QUOTE)', () => {
    assert.throws(attempt((c) => {
      const { result: fake } = c.chain.deploy(QuoteRequest, c.a.shipper, { requester: c.a.shipper, invited: [c.a.carrier], job: jobHash(c.args), consignment: CONSIGNMENT, dispute: disputeOf(c.args), maxRounds: 3 });
      c.chain.call(fake, 'quote', { terms: c.args.terms, validUntil: c.chain.keyHeight + 9 }, { caller: c.a.carrier });
      c.chain.call(fake, 'accept', { invitee: c.a.carrier, terms: termsHash(c.args.terms) }, { caller: c.a.shipper });
      c.quote = fake; // agreed, on the right terms and job, but not created by the platform
    }), { code: 'UNKNOWN_QUOTE' });
  });
  test('a quote from another platform is UNKNOWN_QUOTE, even if the caller names that platform', () => {
    assert.throws(attempt((c) => {
      const other = agreeQuote(c.chain, c.a.shipper, c.a.carrier, c.args.terms, jobHash(c.args), NO_FEE, disputeOf(c.args)); // a second, look-alike registry
      c.quote = other.quote;
      c.args.platform = other.platform; // ignored: the escrow only trusts its own platform
    }), { code: 'UNKNOWN_QUOTE' });
  });
  test('the agreement is checked before anything else', () => {
    assert.throws(attempt((c) => { c.args.carrier = c.a.stranger; c.args.terms = { price: 0n, schedule: [['X', 0]] }; }), { code: 'NOT_AGREED' });
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
    ['an entry with an extra field', [['A', 20, 99]]],
    ['a non-string location', [[42, 20]]],
    ['an entry missing its percentage', [['A']]],
    ['an entry that is not a pair', ['A']],
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
  test('milestones pay in order: a later location scanned first pays nothing', () => {
    const t = funded([['A', 20], ['B', 30]]);
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'B')), 0n);
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'A')), 200n);
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'B')), 300n);
    assertConserved(t);
  });
  test('rounding accumulates: 50% + 50% of 1 pays 0 then 1, leaving nothing for delivery', () => {
    const t = funded([['A', 50], ['B', 50]], 1n);
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'A')), 0n);
    assert.equal(payeeGets(t, () => scanIn(t, 'attestor', 'B')), 1n);
    assert.equal(payeeGets(t, () => t.call('consignee', 'confirm_delivery', { evidence: H })), 0n);
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
    return () => bookEscrow(chain, a.shipper, args);
  }
  const disputed = (opts) => {
    const t = setup(opts);
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
  test('the panel cap comes from the platform setting (lowered to 3: 3 ok, 4 rejected)', () => {
    const chain = new SimChain();
    const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
    const book = (n) => {
      const args = withFullTerms({ carrier: a.carrier, consignee: a.consignee, attestors: [], panel: Array.from({ length: n }, (_, i) => `ak_demo_cap_${i}`), quorum: 1, window: 1, terms: { price: AMOUNT, schedule: [] }, deadline: chain.keyHeight + DEADLINE_IN });
      const agreed = agreeQuote(chain, a.shipper, a.carrier, args.terms, jobHash(args), NO_FEE, disputeOf(args));
      chain.call(agreed.platform, 'propose', { change: { type: 'SetSetting', key: 'max_panel', value: 3 } }, { caller: a.shipper }); // sole admin, quorum 1
      return () => bookEscrow(chain, a.shipper, args, agreed);
    };
    assert.doesNotThrow(book(3));
    assert.throws(book(4), { code: 'BAD_QUORUM' });
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
    ['add_checkpoint', () => ({ location: 'X', kind: 'Milestone', evidence: H })],
    ['confirm_delivery', () => ({ evidence: H })],
    ['raise_dispute', () => ({})],
    ['vote', () => ({ payCarrierPct: [-1n, 0n, 50n, 100n, 101n][rand(5)] })], // few values, so quorums happen
    ['add_checkpoint', () => ({ location: ['A', 'B', 'C'][rand(3)], kind: ['ScanIn', 'ScanOut'][rand(2)], evidence: H })],
    ['resolve_by_fallback', () => ({})],
    ['refund_after_deadline', () => ({})],
  ];
  for (let run = 0; run < 300; run++) {
    // Odd fee terms so rounding and the minimum are both exercised.
    const t = setup({ schedule: [['A', 20], ['B', 30]], fee: { bps: 250, min: 7n } });
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
