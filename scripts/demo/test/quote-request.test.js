import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { QuoteRequest, QuoteStatus, termsHash, MAX_UNIT_LINES } from '../lib/quote-request.js';
import { Platform } from '../lib/platform.js';
import { CONSIGNMENT } from '../lib/fixtures.js';

const ROLES = ['admin', 'shipper', 'fwdA', 'fwdB', 'stranger', 'arb1', 'arb2', 'arb3'];
const JOB = 'j'.repeat(64);
const TERMS = { price: 3_000n, schedule: [['Yantian', 20]] };
const REVISED = { price: 2_850n, schedule: [['Yantian', 20]] };
const VALID_FOR = 10;
const MAX_ROUNDS = 3;
// The quote's deadline may be as late as the request's deliver-by, and no later.
const DEADLINE = CONSIGNMENT.deliverBy;
const disputeFor = (a) => ({ panel: [a.arb1, a.arb2, a.arb3], quorum: 2, window: 2_160, fallback: 50, challenge: 720 });

function setup() {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 1_000n)]));
  const { result: platform } = chain.deploy(Platform, a.admin, { admins: [a.admin], quorum: 1, treasury: 'ak_demo_treasury' });
  const dispute = disputeFor(a);
  const { result: id } = chain.call(platform, 'new_quote', { invited: [a.fwdA, a.fwdB], job: JOB, consignment: CONSIGNMENT, dispute }, { caller: a.shipper });
  // What a forwarder quotes (price, schedule, deadline), and the terms an agreement on it
  // holds: the quote plus the request's dispute terms (ADR 0015).
  const offer = (terms, changes = {}) => ({ ...terms, deadline: DEADLINE, ...changes });
  const agreed = (terms) => ({ ...offer(terms), ...dispute });
  const call = (role, ep, args = {}, value = 0n) => chain.call(id, ep, args, { caller: a[role], value });
  const until = () => chain.keyHeight + VALID_FOR;
  const quote = (role, terms = TERMS, validUntil = until(), changes = {}) => call(role, 'quote', { terms: offer(terms, changes), validUntil });
  const counter = (role, invitee, price = 2_700n, note = null) => call(role, 'counter', { invitee: a[invitee], price, note });
  const accept = (role, invitee, terms = TERMS) => call(role, 'accept', { invitee: a[invitee], terms: termsHash(offer(terms)) });
  const decline = (role, note = null) => call(role, 'decline', { note });
  const status = () => chain.contractState(id).status;
  const lastEvent = () => {
    const { contract, txHash, ...event } = chain.events(id).at(-1);
    return event;
  };
  return { chain, a, id, call, quote, counter, accept, decline, status, lastEvent, offer, agreed, dispute };
}

function deployer() {
  const chain = new SimChain();
  const a = Object.fromEntries(['s', 'f', 'arb1', 'arb2', 'arb3'].map((r) => [r, chain.createAccount(r, 0n)]));
  const deploy = (args) => chain.deploy(QuoteRequest, a.s, { requester: a.s, invited: [a.f], job: 'j', consignment: CONSIGNMENT, dispute: disputeFor(a), maxRounds: MAX_ROUNDS, ...args });
  return { chain, a, deploy };
}
const deployWith = (consignment) => {
  const { deploy } = deployer();
  return () => deploy({ consignment });
};

describe('terms hash', () => {
  test('is stable for equal terms and changes with any field', () => {
    assert.equal(termsHash(TERMS), termsHash({ schedule: [['Yantian', 20]], price: 3_000n }));
    assert.notEqual(termsHash(TERMS), termsHash(REVISED));
    assert.notEqual(termsHash(TERMS), termsHash({ price: 3_000n, schedule: [['Yantian', 21]] }));
  });
});

describe('init', () => {
  test('rejects an empty invite list (NOT_INVITED)', () => {
    const chain = new SimChain();
    const s = chain.createAccount('s', 0n);
    assert.throws(() => chain.deploy(QuoteRequest, s, { requester: s, invited: [], job: 'j', consignment: CONSIGNMENT, dispute: { panel: ['ak_x'], quorum: 1, window: 1, fallback: 50, challenge: 1 }, maxRounds: 3 }), { code: 'NOT_INVITED' });
  });
  test('rejects inviting yourself (NOT_INVITED)', () => {
    const chain = new SimChain();
    const s = chain.createAccount('s', 0n);
    assert.throws(() => chain.deploy(QuoteRequest, s, { requester: s, invited: [s], job: 'j', consignment: CONSIGNMENT, dispute: { panel: ['ak_x'], quorum: 1, window: 1, fallback: 50, challenge: 1 }, maxRounds: 3 }), { code: 'NOT_INVITED' });
  });
  test('duplicate invitations count once', () => {
    const chain = new SimChain();
    const s = chain.createAccount('s', 0n);
    const f = chain.createAccount('f', 0n);
    const { result: id } = chain.deploy(QuoteRequest, s, { requester: s, invited: [f, f], job: 'j', consignment: CONSIGNMENT, dispute: { panel: ['ak_x'], quorum: 1, window: 1, fallback: 50, challenge: 1 }, maxRounds: 3 });
    assert.deepEqual(chain.contractState(id).invited, [f]);
  });
  test('starts open with no agreement, and shows the consignment', () => {
    const t = setup();
    assert.equal(t.status(), QuoteStatus.Open);
    assert.equal(t.chain.view(t.id, 'agreement'), null);
    assert.deepEqual(t.chain.view(t.id, 'consignment'), CONSIGNMENT);
  });
});

describe('consignment (BAD_CONSIGNMENT)', () => {
  const line = CONSIGNMENT.units[0];
  test(`accepts 1 and ${MAX_UNIT_LINES} unit lines`, () => {
    assert.doesNotThrow(deployWith({ ...CONSIGNMENT, units: [line] }));
    assert.doesNotThrow(deployWith({ ...CONSIGNMENT, units: Array(MAX_UNIT_LINES).fill(line) }));
  });
  for (const [what, consignment] of [
    ['no unit lines', { ...CONSIGNMENT, units: [] }],
    [`${MAX_UNIT_LINES + 1} unit lines`, { ...CONSIGNMENT, units: Array(MAX_UNIT_LINES + 1).fill(line) }],
    ...['count', 'lengthMm', 'widthMm', 'heightMm', 'weightG'].map((field) => [`a ${field} of 0`, { ...CONSIGNMENT, units: [{ ...line, [field]: 0 }] }]),
    ['a fractional weight', { ...CONSIGNMENT, units: [{ ...line, weightG: 1.5 }] }],
    ['an empty origin', { ...CONSIGNMENT, origin: '' }],
    ['an empty destination', { ...CONSIGNMENT, destination: '' }],
    // The consignment is public: places must be UN/LOCODEs, never free text (review on #138).
    ['a street address as the destination', { ...CONSIGNMENT, destination: 'Distributieweg 12, Tilburg' }],
    ['a lower-case code', { ...CONSIGNMENT, origin: 'cnytn' }],
    ['a code with a 1 (UN/LOCODE uses 2-9)', { ...CONSIGNMENT, origin: 'CNYT1' }],
    ['a 4-letter code', { ...CONSIGNMENT, destination: 'NLTL' }],
    ['a digit in the country part', { ...CONSIGNMENT, destination: 'N2TLB' }],
    ['a deliver-by in the past', { ...CONSIGNMENT, deliverBy: 0 }],
  ]) {
    test(`rejects ${what}`, () => assert.throws(deployWith(consignment), { code: 'BAD_CONSIGNMENT' }));
  }
  test('deliver-by is optional', () => assert.doesNotThrow(deployWith({ ...CONSIGNMENT, deliverBy: null })));
  test('accepts codes with digits 2-9 in the place part', () => assert.doesNotThrow(deployWith({ ...CONSIGNMENT, origin: 'DEHA2', destination: 'NLRTM' })));
});

describe('dispute terms (set by the requester, added to every agreement)', () => {
  test('the request shows its dispute terms', () => {
    const t = setup();
    assert.deepEqual(t.chain.view(t.id, 'dispute'), t.dispute);
  });
  test('the agreement adds the request\'s dispute terms to the accepted quote', () => {
    const t = setup();
    t.quote('fwdA');
    t.accept('shipper', 'fwdA');
    assert.equal(t.chain.view(t.id, 'agreement').terms, termsHash(t.agreed(TERMS)));
  });
  test('a quote can\'t set dispute terms: any it names are ignored', () => {
    const t = setup();
    t.quote('fwdA', TERMS, undefined, { panel: [t.a.stranger], quorum: 1, fallback: 100 });
    assert.deepEqual(t.chain.view(t.id, 'thread', { invitee: t.a.fwdA }).quote.terms, t.offer(TERMS));
    t.accept('shipper', 'fwdA');
    assert.equal(t.chain.view(t.id, 'agreement').terms, termsHash(t.agreed(TERMS)));
  });
  test('a deadline at the deliver-by is allowed; one block later is LATE_DEADLINE', () => {
    const t = setup();
    assert.throws(() => t.quote('fwdA', TERMS, undefined, { deadline: DEADLINE + 1 }), { code: 'LATE_DEADLINE' });
    assert.doesNotThrow(() => t.quote('fwdA', TERMS, undefined, { deadline: DEADLINE }));
  });
  test('without a deliver-by, any deadline is allowed', () => {
    const { a, deploy, chain } = deployer();
    const { result: id } = deploy({ consignment: { ...CONSIGNMENT, deliverBy: null } });
    const terms = { ...TERMS, deadline: DEADLINE * 10, ...disputeFor(a) };
    assert.doesNotThrow(() => chain.call(id, 'quote', { terms, validUntil: chain.keyHeight + VALID_FOR }, { caller: a.f }));
  });
  test('the checks come after role and status', () => {
    const t = setup();
    assert.throws(() => t.quote('stranger', TERMS, undefined, { quorum: 9 }), { code: 'NOT_INVITED' });
    t.call('shipper', 'withdraw');
    assert.throws(() => t.quote('fwdA', TERMS, undefined, { quorum: 9 }), { code: 'BAD_STATE' });
  });
  for (const [what, change, code] of [
    ['an empty panel', { panel: [] }, 'BAD_QUORUM'],
    ['a repeated arbiter', { panel: ['ak_a', 'ak_a'] }, 'BAD_QUORUM'],
    ['a quorum of 0', { quorum: 0 }, 'BAD_QUORUM'],
    ['a quorum above the panel size', { quorum: 4 }, 'BAD_QUORUM'],
    ['a window of 0', { window: 0 }, 'BAD_DEADLINE'],
    ['a challenge window of 0', { challenge: 0 }, 'BAD_DEADLINE'],
    ['a fallback of 101', { fallback: 101 }, 'BAD_SPLIT'],
    ['a fallback of -1', { fallback: -1 }, 'BAD_SPLIT'],
  ]) {
    test(`a request with ${what} is rejected (${code})`, () => {
      const { a, deploy } = deployer();
      assert.throws(() => deploy({ dispute: { ...disputeFor(a), ...change } }), { code });
    });
  }
  test('fallbacks of 0 and 100 are allowed', () => {
    const { a, deploy } = deployer();
    assert.doesNotThrow(() => deploy({ dispute: { ...disputeFor(a), fallback: 0 } }));
    assert.doesNotThrow(() => deploy({ dispute: { ...disputeFor(a), fallback: 100 } }));
  });
  test('the requester cannot sit on the panel (CONFLICTED_ARBITER)', () => {
    const { a, deploy } = deployer();
    assert.throws(() => deploy({ dispute: { ...disputeFor(a), panel: [a.s, a.arb1] } }), { code: 'CONFLICTED_ARBITER' });
  });
});

describe('who may quote', () => {
  test('each invited forwarder quotes on its own thread', () => {
    const t = setup();
    t.quote('fwdA');
    t.quote('fwdB', REVISED);
    assert.deepEqual(t.chain.view(t.id, 'thread', { invitee: t.a.fwdA }).quote.terms, t.offer(TERMS));
    assert.deepEqual(t.chain.view(t.id, 'thread', { invitee: t.a.fwdB }).quote.terms, t.offer(REVISED));
  });
  for (const role of ['shipper', 'stranger', 'admin']) {
    test(`${role} cannot quote (NOT_INVITED)`, () => assert.throws(() => setup().quote(role), { code: 'NOT_INVITED' }));
  }
});

describe('who may counter and accept', () => {
  for (const role of ['fwdA', 'fwdB', 'stranger']) {
    test(`${role} cannot counter or accept (ONLY_REQUESTER)`, () => {
      const t = setup();
      t.quote('fwdA');
      assert.throws(() => t.counter(role, 'fwdA'), { code: 'ONLY_REQUESTER' });
      assert.throws(() => t.accept(role, 'fwdA'), { code: 'ONLY_REQUESTER' });
    });
  }
  test('the shipper cannot counter or accept on a stranger thread (NOT_INVITED)', () => {
    const t = setup();
    assert.throws(() => t.counter('shipper', 'stranger'), { code: 'NOT_INVITED' });
    assert.throws(() => t.accept('shipper', 'stranger'), { code: 'NOT_INVITED' });
  });
});

describe('negotiation', () => {
  test('forwarder quotes, shipper counters, forwarder revises, shipper accepts', () => {
    const t = setup();
    t.quote('fwdA', TERMS);
    t.counter('shipper', 'fwdA', 2_800n, 'n'.repeat(64));
    t.quote('fwdA', REVISED);
    t.accept('shipper', 'fwdA', REVISED);
    assert.equal(t.status(), QuoteStatus.Agreed);
    assert.deepEqual(t.chain.view(t.id, 'agreement'), { requester: t.a.shipper, counterparty: t.a.fwdA, terms: termsHash(t.agreed(REVISED)), job: JOB });
  });
  test('the shipper accepts a first quote directly', () => {
    const t = setup();
    t.quote('fwdB');
    t.accept('shipper', 'fwdB');
    assert.equal(t.chain.view(t.id, 'agreement').counterparty, t.a.fwdB);
  });
  test('accepting emits Accepted with the invitee and terms, as the contract does', () => {
    const t = setup();
    t.quote('fwdA');
    t.accept('shipper', 'fwdA');
    assert.deepEqual(t.lastEvent(), { type: 'Accepted', invitee: t.a.fwdA, terms: termsHash(t.offer(TERMS)) });
  });
  test('a counter records the target price and note, and emits the price', () => {
    const t = setup();
    t.quote('fwdA');
    t.counter('shipper', 'fwdA', 2_800n, 'n'.repeat(64));
    assert.deepEqual(t.chain.view(t.id, 'thread', { invitee: t.a.fwdA }).counter, { price: 2_800n, note: 'n'.repeat(64) });
    assert.deepEqual(t.lastEvent(), { type: 'Countered', invitee: t.a.fwdA, price: 2_800n });
  });
  test('accepting with no quote on the thread is rejected (NO_OFFER)', () => {
    assert.throws(() => setup().accept('shipper', 'fwdA'), { code: 'NO_OFFER' });
  });
  test('accepting terms that differ from the quote is rejected (TERMS_CHANGED)', () => {
    const t = setup();
    t.quote('fwdA', TERMS);
    assert.throws(() => t.accept('shipper', 'fwdA', REVISED), { code: 'TERMS_CHANGED' });
  });
  test('a counter of 0 is rejected (BAD_PRICE); 1 is allowed', () => {
    const t = setup();
    t.quote('fwdA');
    assert.throws(() => t.counter('shipper', 'fwdA', 0n), { code: 'BAD_PRICE' });
    assert.doesNotThrow(() => t.counter('shipper', 'fwdA', 1n));
  });
  test('threads are independent', () => {
    const t = setup();
    t.quote('fwdA', TERMS);
    t.quote('fwdB', REVISED);
    t.counter('shipper', 'fwdA');
    t.accept('shipper', 'fwdB', REVISED);
    assert.equal(t.chain.view(t.id, 'agreement').counterparty, t.a.fwdB);
  });
});

describe('turns alternate (NOT_YOUR_TURN)', () => {
  test('a forwarder cannot revise until the shipper counters', () => {
    const t = setup();
    t.quote('fwdA');
    assert.throws(() => t.quote('fwdA', REVISED), { code: 'NOT_YOUR_TURN' });
  });
  test('the shipper cannot counter before a quote, or twice in a row', () => {
    const t = setup();
    assert.throws(() => t.counter('shipper', 'fwdA'), { code: 'NOT_YOUR_TURN' });
    t.quote('fwdA');
    t.counter('shipper', 'fwdA');
    assert.throws(() => t.counter('shipper', 'fwdA'), { code: 'NOT_YOUR_TURN' });
  });
  test('the shipper cannot accept while the forwarder owes a revised quote', () => {
    const t = setup();
    t.quote('fwdA');
    t.counter('shipper', 'fwdA');
    assert.throws(() => t.accept('shipper', 'fwdA'), { code: 'NOT_YOUR_TURN' });
  });
});

describe(`round limit (ADR 0015, max_rounds = ${MAX_ROUNDS} counters)`, () => {
  const rounds = (t, n) => {
    t.quote('fwdA', { price: 3_000n, schedule: [] });
    for (let i = 1; i <= n; i++) {
      t.counter('shipper', 'fwdA', BigInt(2_000 + i));
      t.quote('fwdA', { price: BigInt(3_000 - i), schedule: [] });
    }
  };
  test(`the ${MAX_ROUNDS}rd counter is allowed and the next is ROUND_LIMIT`, () => {
    const t = setup();
    rounds(t, MAX_ROUNDS);
    assert.throws(() => t.counter('shipper', 'fwdA'), { code: 'ROUND_LIMIT' });
  });
  test('the final quote can be accepted', () => {
    const t = setup();
    rounds(t, MAX_ROUNDS);
    t.accept('shipper', 'fwdA', { price: BigInt(3_000 - MAX_ROUNDS), schedule: [] });
    assert.equal(t.status(), QuoteStatus.Agreed);
  });
  test('a quote reports its round, and the last one is final', () => {
    const t = setup();
    rounds(t, MAX_ROUNDS);
    assert.deepEqual(t.chain.view(t.id, 'thread', { invitee: t.a.fwdA }).counters, MAX_ROUNDS);
    assert.equal(t.chain.view(t.id, 'is_final', { invitee: t.a.fwdA }), true);
  });
  test('a final quote declined afterwards is no longer final (THREAD_CLOSED to accept)', () => {
    const t = setup();
    rounds(t, MAX_ROUNDS);
    t.decline('fwdA');
    assert.equal(t.chain.view(t.id, 'is_final', { invitee: t.a.fwdA }), false);
    assert.throws(() => t.accept('shipper', 'fwdA', { price: BigInt(3_000 - MAX_ROUNDS), schedule: [] }), { code: 'THREAD_CLOSED' });
  });
  test('each thread has its own count', () => {
    const t = setup();
    rounds(t, MAX_ROUNDS);
    t.quote('fwdB');
    assert.doesNotThrow(() => t.counter('shipper', 'fwdB'));
  });
  test('the limit is checked after role', () => {
    const t = setup();
    rounds(t, MAX_ROUNDS);
    assert.throws(() => t.counter('fwdA', 'fwdA'), { code: 'ONLY_REQUESTER' });
  });
});

describe('decline', () => {
  test('a forwarder can decline before quoting, and the others carry on', () => {
    const t = setup();
    t.decline('fwdA', 'r'.repeat(64));
    assert.deepEqual(t.lastEvent(), { type: 'Declined', invitee: t.a.fwdA });
    t.quote('fwdB');
    t.accept('shipper', 'fwdB');
    assert.equal(t.status(), QuoteStatus.Agreed);
  });
  test('a forwarder can decline after a counter', () => {
    const t = setup();
    t.quote('fwdA');
    t.counter('shipper', 'fwdA');
    assert.doesNotThrow(() => t.decline('fwdA'));
  });
  test('a declined thread is closed (THREAD_CLOSED)', () => {
    const t = setup();
    t.quote('fwdA');
    t.decline('fwdA');
    assert.throws(() => t.accept('shipper', 'fwdA'), { code: 'THREAD_CLOSED' });
    assert.throws(() => t.counter('shipper', 'fwdA'), { code: 'THREAD_CLOSED' });
    assert.throws(() => t.quote('fwdA'), { code: 'THREAD_CLOSED' });
    assert.throws(() => t.decline('fwdA'), { code: 'THREAD_CLOSED' });
  });
  for (const role of ['shipper', 'stranger']) {
    test(`${role} cannot decline (NOT_INVITED)`, () => assert.throws(() => setup().decline(role), { code: 'NOT_INVITED' }));
  }
  test('no decline once the request is closed (BAD_STATE)', () => {
    const t = setup();
    t.call('shipper', 'withdraw');
    assert.throws(() => t.decline('fwdA'), { code: 'BAD_STATE' });
  });
});

describe('expiry boundaries', () => {
  test('a quote must be valid beyond the current block (OFFER_EXPIRED at now, ok at now + 1)', () => {
    const t = setup();
    assert.throws(() => t.quote('fwdA', TERMS, t.chain.keyHeight), { code: 'OFFER_EXPIRED' });
    assert.doesNotThrow(() => t.quote('fwdA', TERMS, t.chain.keyHeight + 1));
  });
  test('accept is allowed at valid_until and rejected one block later', () => {
    const ok = setup();
    ok.quote('fwdA');
    ok.chain.advanceKeyblocks(VALID_FOR);
    assert.doesNotThrow(() => ok.accept('shipper', 'fwdA'));
    const late = setup();
    late.quote('fwdA');
    late.chain.advanceKeyblocks(VALID_FOR + 1);
    assert.throws(() => late.accept('shipper', 'fwdA'), { code: 'OFFER_EXPIRED' });
  });
});

describe('after the deal or a withdrawal', () => {
  function agreed() {
    const t = setup();
    t.quote('fwdA');
    t.quote('fwdB', REVISED);
    t.accept('shipper', 'fwdA');
    return t;
  }
  test('other threads close: accepting fwdB is BAD_STATE', () => {
    assert.throws(() => agreed().accept('shipper', 'fwdB', REVISED), { code: 'BAD_STATE' });
  });
  test('no further quotes, counters or withdrawal (BAD_STATE)', () => {
    const t = agreed();
    assert.throws(() => t.quote('fwdB'), { code: 'BAD_STATE' });
    assert.throws(() => t.counter('shipper', 'fwdB'), { code: 'BAD_STATE' });
    assert.throws(() => t.call('shipper', 'withdraw'), { code: 'BAD_STATE' });
  });
  test('only the requester may withdraw (ONLY_REQUESTER)', () => {
    const t = setup();
    assert.throws(() => t.call('fwdA', 'withdraw'), { code: 'ONLY_REQUESTER' });
    t.call('shipper', 'withdraw');
    assert.equal(t.status(), QuoteStatus.Cancelled);
    assert.equal(t.chain.view(t.id, 'agreement'), null);
  });
  test('a withdrawn request takes no quotes (BAD_STATE)', () => {
    const t = setup();
    t.call('shipper', 'withdraw');
    assert.throws(() => t.quote('fwdA'), { code: 'BAD_STATE' });
  });
});

test('a closed request answers BAD_STATE whoever is named, so it never reveals who was invited', () => {
  const t = setup();
  t.call('shipper', 'withdraw');
  for (const invitee of ['fwdA', 'stranger']) {
    assert.throws(() => t.counter('shipper', invitee), { code: 'BAD_STATE' });
    assert.throws(() => t.accept('shipper', invitee), { code: 'BAD_STATE' });
  }
});

test('check order: role, then status, then arguments', () => {
  const t = setup();
  t.call('shipper', 'withdraw');
  assert.throws(() => t.quote('stranger', TERMS, 0), { code: 'NOT_INVITED' });
  assert.throws(() => t.quote('fwdA', TERMS, 0), { code: 'BAD_STATE' });
  assert.throws(() => t.counter('fwdA', 'fwdA', 0n), { code: 'ONLY_REQUESTER' });
  assert.throws(() => t.counter('shipper', 'fwdA', 0n), { code: 'BAD_STATE' });
});

test('a quote never accepts money (NOT_PAYABLE)', () => {
  const t = setup();
  assert.throws(() => t.call('shipper', 'withdraw', {}, 1n), { code: 'NOT_PAYABLE' });
});

test('property: one agreement at most, never changed, only quoted terms, no funds held (seeded)', () => {
  const seed = 0x9077;
  let x = seed;
  const rand = (n) => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x % n);
  const termsPool = [TERMS, REVISED];
  for (let run = 0; run < 300; run++) {
    const t = setup();
    let first = null;
    for (let i = 0; i < 16; i++) {
      if (rand(5) === 0) t.chain.advanceKeyblocks(rand(VALID_FOR + 3));
      const role = ROLES[rand(ROLES.length)];
      const thread = ['fwdA', 'fwdB', 'stranger'][rand(3)];
      const terms = termsPool[rand(2)];
      try {
        const action = rand(9);
        if (action < 3) t.quote(role, terms, undefined, rand(4) === 0 ? { quorum: 3 } : {});
        else if (action < 5) t.counter(role, thread, BigInt(rand(3)));
        else if (action < 7) t.accept(role, thread, terms);
        else if (action < 8) t.decline(role);
        else t.call(role, 'withdraw');
      } catch (e) {
        assert.ok(e.code, `seed=${seed} run=${run}: non-contract error ${e}`);
      }
      const agreement = t.chain.view(t.id, 'agreement');
      if (first) assert.deepEqual(agreement, first, `seed=${seed} run=${run}: agreement changed`);
      else if (agreement) {
        first = agreement;
        assert.ok([t.a.fwdA, t.a.fwdB].includes(agreement.counterparty), `seed=${seed} run=${run}: agreed with a non-invitee`);
        assert.ok(termsPool.some((p) => termsHash(t.agreed(p)) === agreement.terms), `seed=${seed} run=${run}: agreed terms without the request's dispute terms`);
      }
      const counters = [t.a.fwdA, t.a.fwdB].map((f) => t.chain.view(t.id, 'thread', { invitee: f })?.counters ?? 0);
      assert.ok(counters.every((c) => c <= MAX_ROUNDS), `seed=${seed} run=${run}: round limit exceeded`);
      assert.equal(t.chain.balanceOf(t.id), 0n);
    }
  }
});
