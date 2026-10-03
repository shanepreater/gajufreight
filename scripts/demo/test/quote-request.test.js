import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { QuoteRequest, QuoteStatus, termsHash } from '../lib/quote-request.js';
import { Platform } from '../lib/platform.js';

const ROLES = ['admin', 'shipper', 'fwdA', 'fwdB', 'stranger'];
const JOB = 'j'.repeat(64);
const TERMS = { price: 3_000n, schedule: [['Yantian', 20]] };
const COUNTER = { price: 2_700n, schedule: [['Yantian', 20]] };
const VALID_FOR = 10;

function setup() {
  const chain = new SimChain();
  const a = Object.fromEntries(ROLES.map((r) => [r, chain.createAccount(r, 1_000n)]));
  const { result: platform } = chain.deploy(Platform, a.admin, { admins: [a.admin], quorum: 1 });
  const { result: id } = chain.call(platform, 'new_quote', { invited: [a.fwdA, a.fwdB], job: JOB }, { caller: a.shipper });
  const call = (role, ep, args = {}, value = 0n) => chain.call(id, ep, args, { caller: a[role], value });
  const until = () => chain.keyHeight + VALID_FOR;
  const propose = (role, invitee, terms = TERMS, validUntil = until()) =>
    call(role, 'propose', { invitee: a[invitee], terms: termsHash(terms), validUntil });
  const accept = (role, invitee, terms = TERMS) => call(role, 'accept', { invitee: a[invitee], terms: termsHash(terms) });
  const status = () => chain.contractState(id).status;
  return { chain, a, id, call, propose, accept, status };
}

describe('terms hash', () => {
  test('is stable for equal terms and changes with any field', () => {
    assert.equal(termsHash(TERMS), termsHash({ schedule: [['Yantian', 20]], price: 3_000n }));
    assert.notEqual(termsHash(TERMS), termsHash(COUNTER));
    assert.notEqual(termsHash(TERMS), termsHash({ price: 3_000n, schedule: [['Yantian', 21]] }));
  });
});

describe('init', () => {
  test('rejects an empty invite list (NOT_INVITED)', () => {
    const chain = new SimChain();
    const s = chain.createAccount('s', 0n);
    assert.throws(() => chain.deploy(QuoteRequest, s, { requester: s, invited: [], job: 'j', maxRounds: 5 }), { code: 'NOT_INVITED' });
  });
  test('rejects inviting yourself (NOT_INVITED)', () => {
    const chain = new SimChain();
    const s = chain.createAccount('s', 0n);
    assert.throws(() => chain.deploy(QuoteRequest, s, { requester: s, invited: [s], job: 'j', maxRounds: 5 }), { code: 'NOT_INVITED' });
  });
  test('duplicate invitations count once', () => {
    const chain = new SimChain();
    const s = chain.createAccount('s', 0n);
    const f = chain.createAccount('f', 0n);
    const { result: id } = chain.deploy(QuoteRequest, s, { requester: s, invited: [f, f], job: 'j', maxRounds: 5 });
    assert.deepEqual(chain.contractState(id).invited, [f]);
  });
  test('starts open with no agreement', () => {
    const t = setup();
    assert.equal(t.status(), QuoteStatus.Open);
    assert.equal(t.chain.view(t.id, 'agreement'), null);
  });
});

describe('who may propose on which thread', () => {
  for (const [role, thread, ok] of [
    ['shipper', 'fwdA', true],
    ['fwdA', 'fwdA', true],
    ['fwdB', 'fwdA', false], // another invitee's thread
    ['stranger', 'fwdA', false],
    ['stranger', 'stranger', false],
    ['shipper', 'stranger', false], // not invited
  ]) {
    test(`${role} on ${thread}'s thread → ${ok ? 'accepted' : 'NOT_INVITED'}`, () => {
      const t = setup();
      const run = () => t.propose(role, thread);
      if (ok) assert.doesNotThrow(run);
      else assert.throws(run, { code: 'NOT_INVITED' });
    });
  }
});

describe('negotiation', () => {
  test('forwarder quotes, shipper counters, forwarder accepts the counter', () => {
    const t = setup();
    t.propose('fwdA', 'fwdA', TERMS);
    t.propose('shipper', 'fwdA', COUNTER);
    t.accept('fwdA', 'fwdA', COUNTER);
    assert.equal(t.status(), QuoteStatus.Agreed);
    assert.deepEqual(t.chain.view(t.id, 'agreement'), { requester: t.a.shipper, counterparty: t.a.fwdA, terms: termsHash(COUNTER), job: JOB });
  });
  test('shipper accepts a forwarder quote directly', () => {
    const t = setup();
    t.propose('fwdB', 'fwdB');
    t.accept('shipper', 'fwdB');
    assert.equal(t.chain.view(t.id, 'agreement').counterparty, t.a.fwdB);
  });
  test('nobody can accept their own offer (OWN_OFFER)', () => {
    const t = setup();
    t.propose('fwdA', 'fwdA');
    assert.throws(() => t.accept('fwdA', 'fwdA'), { code: 'OWN_OFFER' });
    t.propose('shipper', 'fwdA', COUNTER);
    assert.throws(() => t.accept('shipper', 'fwdA', COUNTER), { code: 'OWN_OFFER' });
  });
  test('accepting terms that changed is rejected (TERMS_CHANGED)', () => {
    const t = setup();
    t.propose('fwdA', 'fwdA', TERMS);
    t.propose('fwdA', 'fwdA', COUNTER); // replaced before the shipper accepted
    assert.throws(() => t.accept('shipper', 'fwdA', TERMS), { code: 'TERMS_CHANGED' });
  });
  test('accepting with no offer on the thread is rejected (NO_OFFER)', () => {
    const t = setup();
    assert.throws(() => t.accept('shipper', 'fwdA'), { code: 'NO_OFFER' });
  });
  test('threads are independent', () => {
    const t = setup();
    t.propose('fwdA', 'fwdA', TERMS);
    t.propose('fwdB', 'fwdB', COUNTER);
    assert.throws(() => t.accept('shipper', 'fwdA', COUNTER), { code: 'TERMS_CHANGED' });
    t.accept('shipper', 'fwdB', COUNTER);
    assert.equal(t.chain.view(t.id, 'agreement').counterparty, t.a.fwdB);
  });
});

describe('round limit (ADR 0005, max_rounds = 5)', () => {
  const alternate = (t, n) => {
    for (let i = 0; i < n; i++) t.propose(i % 2 ? 'shipper' : 'fwdA', 'fwdA', { price: BigInt(3_000 + i), schedule: [] });
  };
  test('the 5th proposal on a thread is allowed and the 6th is ROUND_LIMIT', () => {
    const t = setup();
    alternate(t, 5);
    assert.throws(() => t.propose('shipper', 'fwdA', COUNTER), { code: 'ROUND_LIMIT' });
  });
  test('the final (5th) offer can still be accepted', () => {
    const t = setup();
    alternate(t, 5); // the 5th is by fwdA (even index 4)
    t.accept('shipper', 'fwdA', { price: 3_004n, schedule: [] });
    assert.equal(t.status(), QuoteStatus.Agreed);
  });
  test('each thread has its own round count', () => {
    const t = setup();
    alternate(t, 5);
    assert.doesNotThrow(() => t.propose('fwdB', 'fwdB'));
  });
  test('the limit is checked after role and status', () => {
    const t = setup();
    alternate(t, 5);
    assert.throws(() => t.propose('stranger', 'fwdA'), { code: 'NOT_INVITED' });
  });
});

describe('expiry boundaries', () => {
  test('an offer must be valid beyond the current block (OFFER_EXPIRED at now, ok at now + 1)', () => {
    const t = setup();
    assert.throws(() => t.propose('fwdA', 'fwdA', TERMS, t.chain.keyHeight), { code: 'OFFER_EXPIRED' });
    assert.doesNotThrow(() => t.propose('fwdA', 'fwdA', TERMS, t.chain.keyHeight + 1));
  });
  test('accept is allowed at valid_until and rejected one block later', () => {
    const ok = setup();
    ok.propose('fwdA', 'fwdA');
    ok.chain.advanceKeyblocks(VALID_FOR);
    assert.doesNotThrow(() => ok.accept('shipper', 'fwdA'));
    const late = setup();
    late.propose('fwdA', 'fwdA');
    late.chain.advanceKeyblocks(VALID_FOR + 1);
    assert.throws(() => late.accept('shipper', 'fwdA'), { code: 'OFFER_EXPIRED' });
  });
});

describe('after the deal or a withdrawal', () => {
  function agreed() {
    const t = setup();
    t.propose('fwdA', 'fwdA');
    t.propose('fwdB', 'fwdB', COUNTER);
    t.accept('shipper', 'fwdA');
    return t;
  }
  test('other threads close: accepting fwdB is BAD_STATE', () => {
    assert.throws(() => agreed().accept('shipper', 'fwdB', COUNTER), { code: 'BAD_STATE' });
  });
  test('no further proposals or withdrawal (BAD_STATE)', () => {
    const t = agreed();
    assert.throws(() => t.propose('fwdA', 'fwdA', COUNTER), { code: 'BAD_STATE' });
    assert.throws(() => t.call('shipper', 'withdraw'), { code: 'BAD_STATE' });
  });
  test('only the requester may withdraw (ONLY_REQUESTER)', () => {
    const t = setup();
    assert.throws(() => t.call('fwdA', 'withdraw'), { code: 'ONLY_REQUESTER' });
    t.call('shipper', 'withdraw');
    assert.equal(t.status(), QuoteStatus.Cancelled);
    assert.equal(t.chain.view(t.id, 'agreement'), null);
  });
  test('a withdrawn request takes no offers (BAD_STATE)', () => {
    const t = setup();
    t.call('shipper', 'withdraw');
    assert.throws(() => t.propose('fwdA', 'fwdA'), { code: 'BAD_STATE' });
  });
});

test('check order: role, then status, then arguments', () => {
  const t = setup();
  t.call('shipper', 'withdraw');
  assert.throws(() => t.propose('stranger', 'fwdA', TERMS, 0), { code: 'NOT_INVITED' });
  assert.throws(() => t.propose('fwdA', 'fwdA', TERMS, 0), { code: 'BAD_STATE' });
});

test('a quote never accepts money (NOT_PAYABLE)', () => {
  const t = setup();
  assert.throws(() => t.call('shipper', 'withdraw', {}, 1n), { code: 'NOT_PAYABLE' });
});

test('property: one agreement at most, never changed, no funds held (seeded)', () => {
  const seed = 0x9077;
  let x = seed;
  const rand = (n) => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x % n);
  const termsPool = [TERMS, COUNTER];
  for (let run = 0; run < 300; run++) {
    const t = setup();
    let first = null;
    for (let i = 0; i < 14; i++) {
      if (rand(5) === 0) t.chain.advanceKeyblocks(rand(VALID_FOR + 3));
      const role = ROLES[rand(ROLES.length)];
      const thread = ['fwdA', 'fwdB', 'stranger'][rand(3)];
      const terms = termsPool[rand(2)];
      try {
        const action = rand(5);
        if (action < 2) t.propose(role, thread, terms);
        else if (action < 4) t.accept(role, thread, terms);
        else t.call(role, 'withdraw');
      } catch (e) {
        assert.ok(e.code, `seed=${seed} run=${run}: non-contract error ${e}`);
      }
      const agreement = t.chain.view(t.id, 'agreement');
      if (first) assert.deepEqual(agreement, first, `seed=${seed} run=${run}: agreement changed`);
      else if (agreement) first = agreement;
      assert.equal(t.chain.balanceOf(t.id), 0n);
    }
  }
});
