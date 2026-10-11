// On-chain verification record (ADR 0019): a verifier the admins vote in records that an
// address belongs to a verified business, until when, and a salted fingerprint of the company's
// details. No names go on-chain; anyone holding the details and salt can check them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain } from '../lib/sim-chain.js';
import { Platform, verificationCommitment } from '../lib/platform.js';

const TREASURY = 'ak_demo_treasury';
const COMPANY = { name: 'Tasman Freight Forwarding Ltd', country: 'NZ', number: '9429041234567', salt: 's'.repeat(64) };

function world({ quorum = 1 } = {}) {
  const chain = new SimChain();
  const a = Object.fromEntries(['admin1', 'admin2', 'verifier', 'forwarder', 'stranger'].map((r) => [r, chain.createAccount(r, 0n)]));
  const { result: platform } = chain.deploy(Platform, a.admin1, { admins: [a.admin1, a.admin2], quorum, treasury: TREASURY });
  const call = (role, ep, args = {}) => chain.call(platform, ep, args, { caller: a[role] });
  const vote = (change) => {
    const { result: id } = call('admin1', 'propose', { change });
    if (quorum > 1) call('admin2', 'approve', { id });
  };
  return { chain, a, platform, call, vote };
}

function withVerifier() {
  const w = world();
  w.vote({ type: 'SetVerifier', verifier: w.a.verifier });
  return w;
}

const commitment = verificationCommitment(COMPANY);
const verify = (w, { account = w.a.forwarder, expiresIn = 100, by = 'verifier' } = {}) =>
  w.call(by, 'verify', { account, commitment, expires: w.chain.keyHeight + expiresIn });

describe('the verifier', () => {
  test('is set only by an admin quorum', () => {
    const w = world({ quorum: 2 });
    const change = { type: 'SetVerifier', verifier: w.a.verifier };
    assert.throws(() => w.call('stranger', 'propose', { change }), { code: 'ONLY_ADMIN' });
    const { result: id } = w.call('admin1', 'propose', { change });
    assert.equal(w.chain.view(w.platform, 'verifier'), null, 'one approval is not enough');
    w.call('admin2', 'approve', { id });
    assert.equal(w.chain.view(w.platform, 'verifier'), w.a.verifier);
  });

  test('rejects an empty verifier address (BAD_SETTING)', () => {
    const w = world();
    assert.throws(() => w.vote({ type: 'SetVerifier', verifier: '' }), { code: 'BAD_SETTING' });
  });

  test('nobody can verify before one is set (ONLY_VERIFIER)', () => {
    const w = world();
    for (const role of ['admin1', 'forwarder', 'stranger']) assert.throws(() => verify(w, { by: role }), { code: 'ONLY_VERIFIER' }, role);
  });

  test('a rotated-out verifier can no longer verify', () => {
    const w = withVerifier();
    w.vote({ type: 'SetVerifier', verifier: w.a.admin2 });
    assert.throws(() => verify(w), { code: 'ONLY_VERIFIER' });
    assert.doesNotThrow(() => verify(w, { by: 'admin2' }));
  });
});

describe('verify', () => {
  test('records the commitment and expiry, and emits Verified', () => {
    const w = withVerifier();
    verify(w);
    const record = w.chain.view(w.platform, 'verification', { account: w.a.forwarder });
    assert.deepEqual(record, { commitment, expires: w.chain.keyHeight + 100, revoked: false });
    assert.ok(w.chain.events(w.platform).some((e) => e.type === 'Verified' && e.account === w.a.forwarder));
  });

  test('only the verifier (ONLY_VERIFIER)', () => {
    const w = withVerifier();
    for (const role of ['admin1', 'forwarder', 'stranger']) assert.throws(() => verify(w, { by: role }), { code: 'ONLY_VERIFIER' }, role);
  });

  test('expiry must be after the current block (BAD_EXPIRY)', () => {
    const w = withVerifier();
    assert.throws(() => verify(w, { expiresIn: 0 }), { code: 'BAD_EXPIRY' });
    assert.doesNotThrow(() => verify(w, { expiresIn: 1 }));
  });

  test('re-verifying renews the record and clears a revocation', () => {
    const w = withVerifier();
    verify(w);
    w.call('verifier', 'revoke', { account: w.a.forwarder });
    verify(w, { expiresIn: 500 });
    const record = w.chain.view(w.platform, 'verification', { account: w.a.forwarder });
    assert.equal(record.revoked, false);
    assert.equal(record.expires, w.chain.keyHeight + 500);
  });

  test('an unknown account has no record', () => {
    const w = withVerifier();
    assert.equal(w.chain.view(w.platform, 'verification', { account: w.a.stranger }), null);
  });
});

describe('revoke', () => {
  test('marks the record revoked and emits Revoked', () => {
    const w = withVerifier();
    verify(w);
    w.call('verifier', 'revoke', { account: w.a.forwarder });
    assert.equal(w.chain.view(w.platform, 'verification', { account: w.a.forwarder }).revoked, true);
    assert.ok(w.chain.events(w.platform).some((e) => e.type === 'Revoked' && e.account === w.a.forwarder));
  });

  test('only the verifier (ONLY_VERIFIER), and only a verified account (NOT_VERIFIED)', () => {
    const w = withVerifier();
    verify(w);
    assert.throws(() => w.call('admin1', 'revoke', { account: w.a.forwarder }), { code: 'ONLY_VERIFIER' });
    assert.throws(() => w.call('verifier', 'revoke', { account: w.a.stranger }), { code: 'NOT_VERIFIED' });
  });
});

describe('is_verified: what anyone checks', () => {
  test('true while current, false once expired or revoked, and false for unknown accounts', () => {
    const w = withVerifier();
    const isVerified = () => w.chain.view(w.platform, 'is_verified', { account: w.a.forwarder });
    assert.equal(isVerified(), false, 'not yet verified');
    verify(w, { expiresIn: 10 });
    assert.equal(isVerified(), true);
    w.chain.advanceKeyblocks(10);
    assert.equal(isVerified(), true, 'at the expiry block');
    w.chain.advanceKeyblocks(1);
    assert.equal(isVerified(), false, 'one block after');
    verify(w);
    w.call('verifier', 'revoke', { account: w.a.forwarder });
    assert.equal(isVerified(), false, 'revoked');
  });
});

describe('matches: proving who a verified address belongs to', () => {
  const matches = (w, details) => w.chain.view(w.platform, 'matches', { account: w.a.forwarder, ...details });

  test('the company details and salt match the fingerprint', () => {
    const w = withVerifier();
    verify(w);
    assert.equal(matches(w, COMPANY), true);
  });

  test('any detail wrong, or the wrong salt, does not match', () => {
    const w = withVerifier();
    verify(w);
    for (const key of ['name', 'country', 'number', 'salt']) {
      assert.equal(matches(w, { ...COMPANY, [key]: `${COMPANY[key]}x` }), false, key);
    }
  });

  test('an expired or revoked verification no longer matches', () => {
    const w = withVerifier();
    verify(w, { expiresIn: 10 });
    w.chain.advanceKeyblocks(11);
    assert.equal(matches(w, COMPANY), false, 'expired');
    verify(w);
    w.call('verifier', 'revoke', { account: w.a.forwarder });
    assert.equal(matches(w, COMPANY), false, 'revoked');
  });

  test('an unverified account matches nothing', () => {
    const w = withVerifier();
    assert.equal(matches(w, COMPANY), false);
  });
});
