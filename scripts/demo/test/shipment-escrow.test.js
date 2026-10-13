import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { escrowFor, templateArgs, Status, TERMINAL } from '../lib/shipment-escrow.js';
import { QuoteRequest, jobHash, termsHash, quoteTerms } from '../lib/quote-request.js';
import { Platform } from '../lib/platform.js';
import { CONSIGNMENT } from '../lib/fixtures.js';
import { verifyArbiters, installFor, paidOut, paidTo as paidToAddress, PLACEHOLDER_FEES, seeded } from './support.js';

const AMOUNT = 1_000n;
const DEADLINE_IN = 10;
const WINDOW = 5; // arbitration window, in blocks
const QUORUM = 2; // of a three-arbiter panel
const H = 'a'.repeat(64);
const ARBITERS = ['arbiter', 'arbiter2', 'arbiter3'];
const ROLES = ['shipper', 'carrier', 'consignee', 'attestor', ...ARBITERS, 'stranger'];
const TREASURY = 'ak_demo_treasury';
// Most tests check exact payouts, so fees are off unless a test turns them on (ADR 0018).
const NO_FEE = { bps: 0, min: 0n };
const CHALLENGE = 720;

// The request's dispute terms, and the full terms a quote carries (ADR 0011, ADR 0015):
// the booking's panel, quorum, window and fallback, its deadline, plus price and schedule.
const disputeOf = (args) => ({ panel: args.panel, quorum: args.quorum, window: args.window, fallback: Number(args.fallback ?? 50n), challenge: CHALLENGE });
const withFullTerms = (args) => ({ ...args, terms: { ...args.terms, attestors: args.attestors, deadline: args.deadline, ...disputeOf(args) } });

// Sole admin (quorum 1), so each proposal applies at once.
function setFee(chain, platform, admin, { bps, min, bondBps = 0 }) {
  chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'fee_bps', value: bps } }, { caller: admin });
  chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'bond_bps', value: bondBps } }, { caller: admin });
  chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'min_fee', value: min } }, { caller: admin });
  // No arbiter fee, so these tests' disputes need no deposit (arbitration.test.js covers fees).
  chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'arbiter_fee_bps', value: 0 } }, { caller: admin });
  chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'min_arbiter_fee', value: 0n } }, { caller: admin });
}

// Agrees terms through a registered QuoteRequest for exactly this job, so every escrow
// passes the UNKNOWN_QUOTE and NOT_AGREED gates (ADR 0004, ADR 0005).
function agreeQuote(chain, requester, payee, terms, job, fee, dispute) {
  const { result: platform } = chain.deploy(Platform, requester, { admins: [requester], quorum: 1, treasury: TREASURY });
  installFor(chain, platform, requester);
  setFee(chain, platform, requester, fee);
  verifyArbiters(chain, platform, requester, dispute.panel);
  const { result: quote } = chain.call(platform, 'new_quote', { invited: [payee], job, consignment: CONSIGNMENT, dispute }, { caller: requester });
  chain.call(quote, 'quote', { terms, validUntil: chain.keyHeight + 100 }, { caller: payee });
  chain.call(quote, 'accept', { invitee: payee, terms: termsHash(quoteTerms(terms)) }, { caller: requester });
  return { platform, quote };
}

const fundingFor = (price) => (typeof price === 'bigint' && price > 0n ? price : 0n);

// Agrees a quote for `args` (unless one is given), then books and funds the escrow in one
// call through the platform; booking names only the quote and the job (ADR 0011).
function bookEscrow(chain, shipper, given, { value = fundingFor(given.terms.price), quote, platform, fee } = {}) {
  const args = withFullTerms(given);
  const agreed = quote ? { quote, platform } : agreeQuote(chain, shipper, args.carrier, args.terms, jobHash(args), fee ?? NO_FEE, disputeOf(args));
  return chain.call(agreed.platform, 'book', { quote: agreed.quote, manifest: args.manifest, consignee: args.consignee }, { caller: shipper, value });
}

// Books and, unless `confirm` is false, has the payee confirm with its bond (ADR 0018), as the demo does.
function setup({ amount = AMOUNT, quorum = QUORUM, fallback, manifest = 'c'.repeat(64), schedule = [], fee, confirm = true } = {}) {
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
  if (confirm) chain.call(id, 'confirm', {}, { caller: a.carrier, value: chain.contractState(id).bond });
  const call = (role, ep, args = {}, value = 0n) => chain.call(id, ep, args, { caller: a[role], value });
  const status = () => chain.contractState(id).status;
  return { chain, a, id, call, status, amount };
}

// Drive a fresh contract into the given status.
function inStatus(target) {
  const t = setup({ confirm: target !== Status.Unconfirmed }); // created and funded in one call
  switch (target) {
    case Status.Unconfirmed:
    case Status.Funded:
      break;
    case Status.InTransit:
      t.call('carrier', 'add_checkpoint', { location: 'X', kind: 'Milestone', evidence: H });
      break;
    case Status.Delivered: // an attestor delivery without the consignee's code is held (ADR 0006)
      t.call('attestor', 'confirm_delivery', { evidence: H });
      break;
    case Status.DisputeFlagged:
      t.call('attestor', 'flag_dispute', { evidence: H });
      break;
    case Status.Disputed:
      t.call('shipper', 'raise_dispute');
      break;
    case Status.Released:
      t.call('consignee', 'confirm_delivery', { evidence: H });
      break;
    case Status.Resolved:
      t.call('shipper', 'raise_dispute');
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

// Conservation (ADR 0018): every terminal state has paid out exactly the funded price plus the
// payee's bond (payee, treasury and shipper together) and holds nothing; the fee is the one
// fixed at booking, paid once at confirmation.
function assertConserved({ chain, id, amount }) {
  const paid = paidOut(chain, id);
  const s = chain.contractState(id);
  const confirmed = chain.events(id).some((e) => e.type === 'Confirmed');
  const staked = confirmed ? s.bond : 0n;
  const fees = chain.events(id).filter((e) => e.type === 'FeePaid').reduce((sum, e) => sum + e.amount, 0n);
  assert.equal(fees, confirmed ? s.fee : 0n, 'the fee is paid once, at confirmation');
  assert.equal(paid, s.paidOut + s.bondOut, 'Paid events match price and bond paid out');
  if (TERMINAL.has(s.status)) {
    assert.equal(paid, amount + staked, 'terminal: paid == funded + bond');
    assert.equal(chain.balanceOf(id), 0n, 'terminal: escrow empty');
  } else {
    assert.equal(chain.balanceOf(id), amount - s.paidOut + staked - s.bondOut + s.deposit - s.depositOut, 'open: escrow holds the rest');
  }
}

describe('init', () => {
  // A fresh shipper and payee per deploy, with an agreed quote for `price`.
  function deployFor(price, overrides = {}) {
    const chain = new SimChain();
    const shipper = chain.createAccount('s', 10_000n);
    const carrier = chain.createAccount('c', 0n);
    const args = { carrier, consignee: chain.createAccount('k', 0n), manifest: 'm'.repeat(64), attestors: [], panel: ['ak_demo_arbiter_x'], quorum: 1, window: 1, terms: { price, schedule: [] }, deadline: chain.keyHeight + 1, ...overrides(chain) };
    const run = () => bookEscrow(chain, shipper, args);
    run.chain = chain;
    return run;
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
  test('rejects the payee as an attestor (CONFLICTED_ATTESTOR)', () => {
    assert.throws(deployFor(1n, () => ({ attestors: ['ak_demo_c'] })), { code: 'CONFLICTED_ATTESTOR' });
  });
  test('attestor limit: 10 accepted, 11 rejected (BAD_ATTESTORS)', () => {
    const named = (n) => () => ({ attestors: Array.from({ length: n }, (_, i) => `ak_demo_attestor_${i}`) });
    assert.doesNotThrow(deployFor(1n, named(10)));
    assert.throws(deployFor(1n, named(11)), { code: 'BAD_ATTESTORS' });
  });
  test('duplicate attestors count against the limit as listed, then collapse', () => {
    const ten = Array.from({ length: 10 }, () => 'ak_demo_attestor_x');
    const deploy = deployFor(1n, () => ({ attestors: ten }));
    const { result: id } = deploy();
    assert.deepEqual(deploy.chain.contractState(id).attestors, ['ak_demo_attestor_x']);
  });
  test('rejects deadline at current height (BAD_DEADLINE), accepts height + 1', () => {
    assert.throws(deployFor(1n, (chain) => ({ deadline: chain.keyHeight })), { code: 'BAD_DEADLINE' });
    assert.doesNotThrow(deployFor(1n, (chain) => ({ deadline: chain.keyHeight + 1 })));
  });
});

describe('role matrix: only the listed roles may call each entrypoint', () => {
  const cases = [
    { ep: 'confirm', from: Status.Unconfirmed, allowed: ['carrier'], denied: 'ONLY_PAYEE' },
    { ep: 'cancel_booking', from: Status.Unconfirmed, allowed: ['shipper', 'carrier'], denied: 'UNAUTHORIZED' },
    { ep: 'add_checkpoint', from: Status.Funded, allowed: ['carrier', 'attestor'], denied: 'UNAUTHORIZED', args: { location: 'X', kind: 'Milestone', evidence: H } },
    { ep: 'confirm_delivery', from: Status.InTransit, allowed: ['consignee', 'attestor'], denied: 'UNAUTHORIZED', args: { evidence: H } },
    { ep: 'raise_dispute', from: Status.InTransit, allowed: ['shipper', 'carrier'], denied: 'UNAUTHORIZED' },
    { ep: 'vote', from: Status.Disputed, allowed: ARBITERS, denied: 'ONLY_ARBITER', args: { payCarrierPct: 50n } },
    { ep: 'resolve_by_fallback', from: Status.Disputed, after: WINDOW + 1, allowed: ['shipper', 'carrier', 'consignee', ...ARBITERS], denied: 'UNAUTHORIZED' },
    { ep: 'release_after_window', from: Status.Delivered, after: CHALLENGE + 1, allowed: ROLES },
    { ep: 'flag_dispute', from: Status.Delivered, allowed: ['attestor'], denied: 'UNAUTHORIZED', args: { evidence: H } },
    { ep: 'release_to_payer', from: Status.Delivered, allowed: ['carrier'], denied: 'ONLY_PAYEE' },
    { ep: 'add_attestor', from: Status.InTransit, allowed: ['shipper'], denied: 'ONLY_SHIPPER', args: (a) => ({ attestor: a.stranger }) },
    { ep: 'remove_attestor', from: Status.InTransit, allowed: ['shipper', 'carrier'], denied: 'UNAUTHORIZED', args: (a) => ({ attestor: a.attestor }) },
  ];
  for (const c of cases) {
    for (const role of ROLES) {
      const ok = c.allowed.includes(role);
      test(`${c.ep} by ${role} → ${ok ? 'accepted' : c.denied}`, () => {
        const t = inStatus(c.from);
        if (c.after) t.chain.advanceKeyblocks(c.after);
        const args = typeof c.args === 'function' ? c.args(t.a) : c.args;
        const run = () => t.call(role, c.ep, args, c.value ?? 0n);
        if (ok) assert.doesNotThrow(run);
        else assert.throws(run, { code: c.denied });
        assertConserved(t);
      });
    }
  }
  test('raise_dispute on a held delivery: the shipper may, the payee may not (UNAUTHORIZED)', () => {
    for (const role of ROLES) {
      const t = inStatus(Status.Delivered);
      const run = () => t.call(role, 'raise_dispute');
      if (role === 'shipper') assert.doesNotThrow(run);
      else assert.throws(run, { code: 'UNAUTHORIZED' }, role);
      assertConserved(t);
    }
  });
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
    { ep: 'confirm', role: 'carrier', ok: [Status.Unconfirmed] },
    { ep: 'cancel_booking', role: 'shipper', ok: [Status.Unconfirmed] },
    { ep: 'add_checkpoint', role: 'carrier', ok: [Status.Funded, Status.InTransit], args: { location: 'X', kind: 'Milestone', evidence: H } },
    { ep: 'confirm_delivery', role: 'consignee', ok: [Status.Funded, Status.InTransit], args: { evidence: H } },
    { ep: 'raise_dispute', role: 'shipper', ok: [Status.Funded, Status.InTransit, Status.Delivered, Status.DisputeFlagged] },
    { ep: 'flag_dispute', role: 'attestor', ok: [Status.Funded, Status.InTransit, Status.Delivered], args: { evidence: H } },
    { ep: 'release_after_window', role: 'stranger', ok: [Status.Delivered], after: CHALLENGE + 1 },
    { ep: 'release_to_payer', role: 'carrier', ok: [Status.Funded, Status.InTransit, Status.Delivered] },
    { ep: 'add_attestor', role: 'shipper', ok: [Status.Funded, Status.InTransit], args: (a) => ({ attestor: a.stranger }) },
    { ep: 'remove_attestor', role: 'shipper', ok: [Status.Funded, Status.InTransit], args: (a) => ({ attestor: a.attestor }) },
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
        if (c.after) t.chain.advanceKeyblocks(c.after);
        const args = typeof c.args === 'function' ? c.args(t.a) : c.args;
        const run = () => t.call(c.role, c.ep, args, c.value ?? 0n);
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
  test('the exact price creates an Unconfirmed escrow holding it, in one call', () => {
    const { chain, run } = bookWith(AMOUNT);
    const { result: id } = run();
    assert.equal(chain.contractState(id).status, Status.Unconfirmed);
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
    t.call('attestor', 'confirm_delivery', { evidence: H, codeChecked: true });
    assert.equal(t.status(), Status.Released);
  });
  test('a held delivery can no longer be refunded after the deadline (BAD_STATE)', () => {
    const t = inStatus(Status.Delivered);
    t.chain.advanceKeyblocks(DEADLINE_IN + 1);
    assert.throws(() => t.call('shipper', 'refund_after_deadline'), { code: 'BAD_STATE' });
    assertConserved(t);
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
            t.call('shipper', 'raise_dispute');
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

describe('booked only through the platform, from a registered, agreed quote (ADR 0004, 0005, 0011)', () => {
  // Agrees a registered quote for the canonical args; `mutate` then changes what is booked.
  function attempt(mutate) {
    const chain = new SimChain();
    const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
    const args = withFullTerms({ carrier: a.carrier, consignee: a.consignee, attestors: [], panel: [a.arbiter], quorum: 1, window: 1, manifest: 'm'.repeat(64), terms: { price: AMOUNT, schedule: [['Yantian', 20]] }, deadline: chain.keyHeight + DEADLINE_IN });
    const agreed = agreeQuote(chain, a.shipper, a.carrier, args.terms, jobHash(args), NO_FEE, disputeOf(args));
    const c = { chain, a, args: { ...args }, caller: a.shipper, value: AMOUNT, ...agreed };
    mutate?.(c);
    const run = () => chain.call(c.platform, 'book', { quote: c.quote, manifest: c.args.manifest, consignee: c.args.consignee }, { caller: c.caller, value: c.value });
    run.c = c;
    return run;
  }
  const newQuote = (c) => c.chain.call(c.platform, 'new_quote', { invited: [c.a.carrier], job: jobHash(c.args), consignment: CONSIGNMENT, dispute: disputeOf(c.args) }, { caller: c.a.shipper }).result;

  test('books the agreed quote, registers the escrow and announces it', () => {
    const run = attempt();
    const { result: id } = run();
    const { chain, platform, quote, a } = run.c;
    assert.equal(chain.view(platform, 'is_escrow', { address: id }), true);
    assert.partialDeepStrictEqual(chain.events(platform).at(-1), { type: 'EscrowBooked', escrow: id, quote, payer: a.shipper });
    assert.partialDeepStrictEqual(chain.events(id)[0], { type: 'Booked', quote, payee: a.carrier });
    assert.equal(chain.balanceOf(platform), 0n, 'the platform passes the funding straight to the escrow');
    assert.equal(chain.balanceOf(id), AMOUNT);
  });
  test('reads every term from the agreed quote: payee, price, schedule, deadline, attestors, panel', () => {
    const run = attempt();
    const { result: id } = run();
    const { chain, args, a } = run.c;
    const s = chain.contractState(id);
    assert.equal(s.carrier, a.carrier);
    assert.equal(s.amount, AMOUNT);
    assert.deepEqual(s.schedule.map((m) => [m.location, m.pct]), args.terms.schedule);
    assert.equal(s.deadline, args.terms.deadline);
    assert.deepEqual(s.attestors, args.terms.attestors);
    assert.deepEqual(s.arbiters, args.terms.panel);
  });
  test('rejects a quote that is still open (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.quote = newQuote(c); }), { code: 'NOT_AGREED' });
  });
  test('rejects a withdrawn quote (NOT_AGREED)', () => {
    assert.throws(attempt((c) => {
      c.quote = newQuote(c);
      c.chain.call(c.quote, 'withdraw', {}, { caller: c.a.shipper });
    }), { code: 'NOT_AGREED' });
  });
  test('rejects anyone but the requester booking it (NOT_AGREED)', () => {
    assert.throws(attempt((c) => { c.caller = c.a.stranger; }), { code: 'NOT_AGREED' });
  });
  for (const [label, mutate] of [
    ['a different manifest', (c) => { c.args.manifest = 'n'.repeat(64); }],
    ['a different consignee', (c) => { c.args.consignee = c.a.stranger; }],
  ]) {
    test(`rejects an agreed quote booked for ${label} (NOT_AGREED)`, () => {
      assert.throws(attempt(mutate), { code: 'NOT_AGREED' });
    });
  }
  test('the job is the manifest and consignee only, so the forwarder may choose the deadline', () => {
    assert.equal(jobHash({ manifest: 'm', consignee: 'c', deadline: 1 }), jobHash({ manifest: 'm', consignee: 'c', deadline: 2 }));
  });
  test('rejects funding other than the price (WRONG_AMOUNT), one below and one above', () => {
    assert.throws(attempt((c) => { c.value = AMOUNT - 1n; }), { code: 'WRONG_AMOUNT' });
    assert.throws(attempt((c) => { c.value = AMOUNT + 1n; }), { code: 'WRONG_AMOUNT' });
  });
  test('one escrow per agreement: booking the same quote again is QUOTE_USED', () => {
    const run = attempt();
    run();
    assert.throws(run, { code: 'QUOTE_USED' });
  });
  test('a failed booking leaves the quote unused', () => {
    const run = attempt((c) => { c.value = 1n; });
    assert.throws(run, { code: 'WRONG_AMOUNT' });
    run.c.value = AMOUNT;
    assert.doesNotThrow(run);
  });
  test('rejects a look-alike quote the platform never registered (UNKNOWN_QUOTE)', () => {
    assert.throws(attempt((c) => {
      const { result: fake } = c.chain.deploy(QuoteRequest, c.a.shipper, { requester: c.a.shipper, invited: [c.a.carrier], job: jobHash(c.args), consignment: CONSIGNMENT, dispute: disputeOf(c.args), maxRounds: 3, parent: null, fees: PLACEHOLDER_FEES });
      c.chain.call(fake, 'quote', { terms: c.args.terms, validUntil: c.chain.keyHeight + 9 }, { caller: c.a.carrier });
      c.chain.call(fake, 'accept', { invitee: c.a.carrier, terms: termsHash(quoteTerms(c.args.terms)) }, { caller: c.a.shipper });
      c.quote = fake; // agreed, on the right terms and job, but not created by the platform
    }), { code: 'UNKNOWN_QUOTE' });
  });
  test("a quote from another platform is UNKNOWN_QUOTE on this one", () => {
    assert.throws(attempt((c) => {
      c.quote = agreeQuote(c.chain, c.a.shipper, c.a.carrier, c.args.terms, jobHash(c.args), NO_FEE, disputeOf(c.args)).quote;
    }), { code: 'UNKNOWN_QUOTE' });
  });
  test('bookings closed by the admins stop new escrows (BOOKINGS_CLOSED), never live ones', () => {
    const run = attempt();
    const { chain, platform, a } = run.c;
    const { result: live } = run();
    chain.call(live, 'confirm', {}, { caller: a.carrier, value: chain.contractState(live).bond });
    chain.call(platform, 'propose', { change: { type: 'SetSetting', key: 'bookings_open', value: 0 } }, { caller: a.shipper });
    assert.throws(run, { code: 'BOOKINGS_CLOSED' }, 'checked first, before QUOTE_USED');
    chain.call(live, 'confirm_delivery', { evidence: H }, { caller: a.consignee });
    assert.equal(chain.contractState(live).status, Status.Released);
  });
  test('the pilot cap: a price at max_price books, one above is OVER_LIMIT', () => {
    const cap = (limit) => attempt((c) => {
      c.chain.call(c.platform, 'propose', { change: { type: 'SetSetting', key: 'max_price', value: limit } }, { caller: c.a.shipper });
    });
    assert.doesNotThrow(cap(AMOUNT));
    assert.throws(cap(AMOUNT - 1n), { code: 'OVER_LIMIT' });
  });
});

describe('the escrow template: created by anyone but the platform, it is inert (decision log #34)', () => {
  function template() {
    const chain = new SimChain();
    const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 10_000n)]));
    const { result: platform } = chain.deploy(Platform, a.shipper, { admins: [a.shipper], quorum: 1, treasury: TREASURY });
    // Arguments naming real parties are ignored: every address is the deployer's.
    const { result: id } = chain.deploy(escrowFor(platform), a.stranger, { ...templateArgs(a.stranger, platform), shipper: a.shipper, manifest: 'm'.repeat(64) });
    return { chain, a, id, platform };
  }
  test('it takes no value (WRONG_AMOUNT)', () => {
    const { chain, a, platform } = template();
    assert.throws(() => chain.deploy(escrowFor(platform), a.stranger, templateArgs(a.stranger, platform), { value: 1n }), { code: 'WRONG_AMOUNT' });
  });
  test('it starts terminal and empty, naming only its deployer', () => {
    const { chain, a, id } = template();
    const s = chain.contractState(id);
    assert.equal(s.status, Status.Refunded);
    assert.equal(s.amount, 0n);
    assert.deepEqual([s.shipper, s.carrier, s.treasury, s.raiser], [a.stranger, a.stranger, a.stranger, a.stranger]);
    assert.equal(s.manifest, '0'.repeat(64));
    assert.equal(chain.view(id, 'is_terminal'), true);
  });
  // The deployer is its own payer and payee, so role checks pass and the status rejects: the
  // codes match the contract walked line by line in PR #174's review.
  const calls = [
    ['confirm', {}, 'BAD_STATE'], ['cancel_booking', {}, 'BAD_STATE'],
    ['add_checkpoint', { location: 'X', kind: 'Milestone', evidence: H }, 'BAD_STATE'],
    ['confirm_delivery', { evidence: H, codeChecked: true }, 'UNAUTHORIZED'], ['release_after_window', {}, 'BAD_STATE'],
    ['raise_dispute', {}, 'BAD_STATE'], ['flag_dispute', { evidence: H }, 'UNAUTHORIZED'], ['lapse_dispute', {}, 'BAD_STATE'],
    ['vote', { payCarrierPct: 50n }, 'ONLY_ARBITER'], ['resolve_by_fallback', {}, 'BAD_STATE'],
    ['refund_after_deadline', {}, 'BAD_STATE'], ['release_to_payer', {}, 'BAD_STATE'],
    ['add_attestor', { attestor: 'ak_demo_x' }, 'BAD_STATE'], ['remove_attestor', { attestor: 'ak_demo_x' }, 'BAD_STATE'],
    ['propose_charge', { kind: 'Other', amount: 1n, evidence: H }, 'BAD_STATE'],
    ['accept_charge', { id: 0 }, 'NO_CHARGE'], ['decline_charge', { id: 0 }, 'NO_CHARGE'],
  ];
  for (const [ep, args, code] of calls) {
    test(`${ep} on the template is rejected, even by its deployer (${code})`, () => {
      const { chain, a, id } = template();
      chain.advanceKeyblocks(CHALLENGE + 1);
      assert.throws(() => chain.call(id, ep, args, { caller: a.stranger }), { code });
      assert.equal(chain.balanceOf(id), 0n);
    });
  }
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
    t.call('shipper', 'raise_dispute');
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
    t.call('shipper', 'raise_dispute');
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
    t.call('shipper', 'raise_dispute');
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
  const rand = seeded(seed);
  let cur; // the escrow under test, for the bond confirm must carry
  const eps = [
    ['confirm', () => ({}), () => cur.chain.contractState(cur.id).bond],
    ['cancel_booking', () => ({})],
    ['add_checkpoint', () => ({ location: 'X', kind: 'Milestone', evidence: H })],
    ['confirm_delivery', () => ({ evidence: H, codeChecked: rand(2) === 0 })],
    ['release_after_window', () => ({})],
    ['release_to_payer', () => ({})],
    ['flag_dispute', () => ({ evidence: H })],
    ['lapse_dispute', () => ({})],
    ['add_attestor', () => ({ attestor: cur.a[ROLES[rand(ROLES.length)]] })],
    ['remove_attestor', () => ({ attestor: cur.a[ROLES[rand(ROLES.length)]] })],
    ['raise_dispute', () => ({})],
    ['vote', () => ({ payCarrierPct: [-1n, 0n, 50n, 100n, 101n][rand(5)] })], // few values, so quorums happen
    ['add_checkpoint', () => ({ location: ['A', 'B', 'C'][rand(3)], kind: ['ScanIn', 'ScanOut'][rand(2)], evidence: H })],
    ['resolve_by_fallback', () => ({})],
    ['refund_after_deadline', () => ({})],
  ];
  for (let run = 0; run < 300; run++) {
    // Odd fee terms so rounding and the minimum are both exercised.
    const t = setup({ schedule: [['A', 20], ['B', 30]], fee: { bps: 250, min: 7n }, confirm: rand(3) !== 0 });
    cur = t;
    const supply = t.chain.totalSupply();
    let terminal = null;
    for (let i = 0; i < 12; i++) {
      if (rand(4) === 0) t.chain.advanceKeyblocks(rand(DEADLINE_IN));
      if (rand(12) === 0) t.chain.advanceKeyblocks(CHALLENGE + 1); // past the challenge and deposit windows
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

describe('held delivery and the challenge window (ADR 0006)', () => {
  const paidTo = (t, who) => paidToAddress(t.chain, t.id, t.a[who]);
  // The block the delivery was held at, so boundaries are counted from it.
  const deliveredAt = (t) => t.chain.contractState(t.id).deliveredAt;
  const toBlock = (t, height) => t.chain.advanceKeyblocks(height - t.chain.keyHeight);
  // No fee, and a 10% performance bond: 100 of the 1,000 price is held until the escrow ends.
  const HELD_BOND = { bps: 0, min: 0n, bondBps: 1000 };

  test("an attestor's delivery without the code holds the remainder: Delivered, nothing paid", () => {
    const t = inStatus(Status.InTransit);
    t.call('attestor', 'confirm_delivery', { evidence: H });
    assert.equal(t.status(), Status.Delivered);
    assert.equal(paidTo(t, 'carrier'), 0n);
    assert.equal(t.chain.events(t.id).at(-2).kind, 'Delivered', 'the delivery checkpoint is still recorded');
    assertConserved(t);
  });
  test("an attestor's delivery with the code checked releases at once", () => {
    const t = inStatus(Status.InTransit);
    t.call('attestor', 'confirm_delivery', { evidence: H, codeChecked: true });
    assert.equal(t.status(), Status.Released);
    assert.equal(paidTo(t, 'carrier'), t.amount);
    assertConserved(t);
  });
  test("the consignee's delivery releases at once, whatever code_checked says", () => {
    const t = inStatus(Status.InTransit);
    t.call('consignee', 'confirm_delivery', { evidence: H, codeChecked: false });
    assert.equal(t.status(), Status.Released);
    assertConserved(t);
  });
  test('release at the end of the window is rejected (CHALLENGE_OPEN); one block after, anyone releases it', () => {
    const t = inStatus(Status.Delivered);
    toBlock(t, deliveredAt(t) + CHALLENGE);
    assert.throws(() => t.call('stranger', 'release_after_window'), { code: 'CHALLENGE_OPEN' });
    t.chain.advanceKeyblocks(1);
    t.call('stranger', 'release_after_window');
    assert.equal(t.status(), Status.Released);
    assert.equal(paidTo(t, 'carrier'), t.amount);
    assertConserved(t);
  });
  test('release pays the remainder after milestones, and returns the held bond', () => {
    const t = setup({ schedule: [['A', 30]], fee: HELD_BOND });
    t.call('attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H });
    t.call('attestor', 'confirm_delivery', { evidence: H });
    t.chain.advanceKeyblocks(CHALLENGE + 1);
    t.call('shipper', 'release_after_window');
    assert.equal(paidTo(t, 'carrier'), t.amount + 100n, 'the price, then the 100 held bond back');
    assertConserved(t);
  });
  test('the shipper disputes a held delivery, and the panel settles it', () => {
    const t = inStatus(Status.Delivered);
    t.call('shipper', 'raise_dispute');
    assert.equal(t.status(), Status.Disputed);
    t.call('arbiter', 'vote', { payCarrierPct: 0n });
    t.call('arbiter2', 'vote', { payCarrierPct: 0n });
    assert.equal(t.status(), Status.Resolved);
    assert.equal(paidTo(t, 'shipper'), t.amount);
    assertConserved(t);
  });
  test("a flag on a held delivery: the payee still can't raise it (UNAUTHORIZED), the shipper can", () => {
    const t = inStatus(Status.Delivered);
    t.call('attestor', 'flag_dispute', { evidence: H });
    assert.equal(t.status(), Status.DisputeFlagged);
    assert.throws(() => t.call('carrier', 'raise_dispute'), { code: 'UNAUTHORIZED' });
    t.call('shipper', 'raise_dispute');
    assert.equal(t.status(), Status.Disputed);
    assertConserved(t);
  });
  test("a flag on a goods-moving escrow can still be raised by the payee", () => {
    const t = inStatus(Status.InTransit);
    t.call('attestor', 'flag_dispute', { evidence: H });
    t.call('carrier', 'raise_dispute');
    assert.equal(t.status(), Status.Disputed);
  });
  test("a lapsed flag returns to Delivered, and the challenge clock isn't reset", () => {
    const t = inStatus(Status.Delivered);
    const held = deliveredAt(t);
    t.call('attestor', 'flag_dispute', { evidence: H });
    const depositWindow = t.chain.contractState(t.id).depositWindow;
    t.chain.advanceKeyblocks(depositWindow + 1);
    t.call('stranger', 'lapse_dispute');
    assert.equal(t.status(), Status.Delivered);
    assert.equal(deliveredAt(t), held);
    assert.ok(t.chain.keyHeight > held + CHALLENGE, 'the deposit window outlasts the challenge window');
    t.call('stranger', 'release_after_window');
    assert.equal(t.status(), Status.Released);
    assertConserved(t);
  });
  test('the payee can release a held delivery to the payer, forfeiting its held bond', () => {
    const t = setup({ fee: HELD_BOND });
    t.call('attestor', 'confirm_delivery', { evidence: H });
    t.call('carrier', 'release_to_payer');
    assert.equal(t.status(), Status.Refunded);
    assert.equal(paidTo(t, 'shipper'), t.amount + 100n, 'the price back, plus the 100 held bond');
    assert.equal(paidTo(t, 'carrier'), 0n);
    assertConserved(t);
  });
  test('nothing else moves a held delivery: checkpoints and a second delivery are BAD_STATE', () => {
    const t = inStatus(Status.Delivered);
    assert.throws(() => t.call('attestor', 'add_checkpoint', { location: 'X', kind: 'Milestone', evidence: H }), { code: 'BAD_STATE' });
    assert.throws(() => t.call('consignee', 'confirm_delivery', { evidence: H }), { code: 'BAD_STATE' });
    assertConserved(t);
  });
});

describe('attestor changes (ADR 0006)', () => {
  test('the payer adds an attestor, who can then attest and deliver', () => {
    const t = inStatus(Status.InTransit);
    t.call('shipper', 'add_attestor', { attestor: t.a.stranger });
    assert.partialDeepStrictEqual(t.chain.events(t.id).at(-1), { type: 'AttestorAdded', attestor: t.a.stranger });
    t.call('stranger', 'confirm_delivery', { evidence: H, codeChecked: true });
    assert.equal(t.status(), Status.Released);
  });
  test('the payee can never be added as an attestor (CONFLICTED_ATTESTOR)', () => {
    const t = inStatus(Status.Funded);
    assert.throws(() => t.call('shipper', 'add_attestor', { attestor: t.a.carrier }), { code: 'CONFLICTED_ATTESTOR' });
  });
  test('an existing attestor, or one past the platform limit, is BAD_ATTESTORS', () => {
    const t = inStatus(Status.Funded);
    assert.throws(() => t.call('shipper', 'add_attestor', { attestor: t.a.attestor }), { code: 'BAD_ATTESTORS' });
    // One attestor at booking; the default limit is 10.
    for (let i = 0; i < 9; i++) t.call('shipper', 'add_attestor', { attestor: t.chain.createAccount(`extra${i}`) });
    assert.throws(() => t.call('shipper', 'add_attestor', { attestor: t.a.stranger }), { code: 'BAD_ATTESTORS' });
  });
  test('add_attestor checks role, then status, then the address', () => {
    const t = inStatus(Status.Delivered);
    assert.throws(() => t.call('carrier', 'add_attestor', { attestor: t.a.carrier }), { code: 'ONLY_SHIPPER' });
    assert.throws(() => t.call('shipper', 'add_attestor', { attestor: t.a.carrier }), { code: 'BAD_STATE' });
  });
  for (const [first, second] of [['shipper', 'carrier'], ['carrier', 'shipper']]) {
    test(`removal needs both parties: ${first} approves, then ${second} removes`, () => {
      const t = inStatus(Status.InTransit);
      t.call(first, 'remove_attestor', { attestor: t.a.attestor });
      assert.partialDeepStrictEqual(t.chain.events(t.id).at(-1), { type: 'AttestorRemovalApproved', attestor: t.a.attestor, by: t.a[first] });
      t.call('attestor', 'add_checkpoint', { location: 'X', kind: 'Milestone', evidence: H }); // still an attestor
      t.call(second, 'remove_attestor', { attestor: t.a.attestor });
      assert.partialDeepStrictEqual(t.chain.events(t.id).at(-1), { type: 'AttestorRemoved', attestor: t.a.attestor });
      assert.throws(() => t.call('attestor', 'confirm_delivery', { evidence: H }), { code: 'UNAUTHORIZED' });
    });
  }
  test('the same party approving twice is ALREADY_APPROVED', () => {
    const t = inStatus(Status.Funded);
    t.call('shipper', 'remove_attestor', { attestor: t.a.attestor });
    assert.throws(() => t.call('shipper', 'remove_attestor', { attestor: t.a.attestor }), { code: 'ALREADY_APPROVED' });
  });
  test('removing an account that is not an attestor is NOT_ATTESTOR', () => {
    const t = inStatus(Status.Funded);
    assert.throws(() => t.call('shipper', 'remove_attestor', { attestor: t.a.stranger }), { code: 'NOT_ATTESTOR' });
  });
  test('a removed attestor added back needs two fresh approvals to remove again', () => {
    const t = inStatus(Status.Funded);
    t.call('shipper', 'remove_attestor', { attestor: t.a.attestor });
    t.call('carrier', 'remove_attestor', { attestor: t.a.attestor });
    t.call('shipper', 'add_attestor', { attestor: t.a.attestor });
    t.call('carrier', 'remove_attestor', { attestor: t.a.attestor });
    assert.equal(t.chain.events(t.id).at(-1).type, 'AttestorRemovalApproved');
  });
});

// The events each path emits, in the contract's order (shipment-escrow.aes): the replay
// compares them call by call (#70), so a reordering here fails before it reaches a chain.
describe('events, as the contract emits them', () => {
  const emitted = (t, receipt) => t.chain.events(t.id).filter((e) => e.txHash === receipt.txHash).map((e) => (e.type === 'StatusChanged' ? `StatusChanged(${e.to})` : e.type));
  // A 10% performance bond and no fee, so a held bond moves at the end.
  const BONDED = { bps: 0, min: 0n, bondBps: 1000 };

  test('confirm: the status, then the bond and fee, then the fee paid', () => {
    const t = setup({ confirm: false, fee: { bps: 100, min: 0n } });
    assert.deepEqual(emitted(t, t.call('carrier', 'confirm', {}, t.chain.contractState(t.id).bond)), ['StatusChanged(Funded)', 'Confirmed', 'FeePaid']);
  });
  test('cancel_booking: who cancelled, the status, the refund', () => {
    const t = setup({ confirm: false });
    assert.deepEqual(emitted(t, t.call('shipper', 'cancel_booking')), ['Cancelled', 'StatusChanged(Refunded)', 'RefundPaid']);
  });
  test('a checkpoint that pays a milestone: no StatusChanged for InTransit, then the payment', () => {
    const t = setup({ schedule: [['A', 20]] });
    assert.deepEqual(emitted(t, t.call('attestor', 'add_checkpoint', { location: 'A', kind: 'ScanIn', evidence: H })), ['CheckpointAdded', 'MilestonePaid']);
  });
  test('delivery released at once returns the held bond after the status', () => {
    const t = setup({ fee: BONDED });
    assert.deepEqual(emitted(t, t.call('consignee', 'confirm_delivery', { evidence: H })), ['CheckpointAdded', 'StatusChanged(Released)', 'BondReleased']);
  });
  test('a delivery held for the window, then released after it', () => {
    const t = setup();
    assert.deepEqual(emitted(t, t.call('attestor', 'confirm_delivery', { evidence: H })), ['CheckpointAdded', 'StatusChanged(Delivered)']);
    t.chain.advanceKeyblocks(CHALLENGE + 1);
    assert.deepEqual(emitted(t, t.call('stranger', 'release_after_window')), ['StatusChanged(Released)']);
  });
  test('a flag, then its lapse: the event before the status each time', () => {
    const t = setup();
    assert.deepEqual(emitted(t, t.call('attestor', 'flag_dispute', { evidence: H })), ['Flagged', 'StatusChanged(DisputeFlagged)']);
    t.chain.advanceKeyblocks(t.chain.contractState(t.id).depositWindow + 1);
    assert.deepEqual(emitted(t, t.call('stranger', 'lapse_dispute')), ['DisputeLapsed', 'StatusChanged(Funded)']);
  });
  test('raise_dispute: the status, then who raised it', () => {
    const t = setup();
    assert.deepEqual(emitted(t, t.call('shipper', 'raise_dispute')), ['StatusChanged(Disputed)', 'DisputeRaised']);
  });
  test('a refund after the deadline: the status, the refund, then the forfeited bond', () => {
    const t = setup({ fee: BONDED });
    t.chain.advanceKeyblocks(DEADLINE_IN + 1);
    assert.deepEqual(emitted(t, t.call('shipper', 'refund_after_deadline')), ['StatusChanged(Refunded)', 'RefundPaid', 'BondReleased']);
  });
});
