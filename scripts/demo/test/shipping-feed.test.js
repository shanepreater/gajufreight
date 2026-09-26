import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedIngest, signWebhook, hashEvidence, verifyEvidence, canonicalJson } from '../lib/shipping-feed.js';

const SECRET = 'test-secret';
const event = { id: 'evt-1', type: 'GATE_IN', location: 'Yantian', details: { b: 2, a: 1 } };

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(hashEvidence({ x: 1, y: 2 }), hashEvidence({ y: 2, x: 1 }));
});

test('accepts a correctly signed event and stores it by hash', () => {
  const feed = new FeedIngest(SECRET);
  const r = feed.ingest(signWebhook(event, SECRET));
  assert.equal(r.accepted, true);
  assert.equal(r.evidenceHash, hashEvidence(event));
  assert.deepEqual(feed.evidence(r.evidenceHash), event);
});

test('rejects duplicate delivery of the same event id (DUPLICATE)', () => {
  const feed = new FeedIngest(SECRET);
  feed.ingest(signWebhook(event, SECRET));
  assert.deepEqual(feed.ingest(signWebhook(event, SECRET)), { accepted: false, reason: 'DUPLICATE' });
});

test('rejects a payload altered after signing (BAD_SIGNATURE)', () => {
  const feed = new FeedIngest(SECRET);
  const hook = signWebhook(event, SECRET);
  hook.event.location = 'Somewhere else';
  assert.equal(feed.ingest(hook).reason, 'BAD_SIGNATURE');
  assert.equal(feed.hasEvent(event.id), false, 'rejected events are not marked seen');
});

test('rejects wrong secret, missing, short, non-hex and malformed signatures', () => {
  const feed = new FeedIngest(SECRET);
  const good = signWebhook(event, SECRET);
  for (const signature of [signWebhook(event, 'other').signature, undefined, '', 'ab', 'z'.repeat(64), good.signature.toUpperCase()]) {
    assert.equal(feed.ingest({ event, signature }).reason, 'BAD_SIGNATURE', String(signature));
  }
  assert.equal(feed.ingest({}).reason, 'BAD_SIGNATURE');
  assert.equal(feed.ingest().reason, 'BAD_SIGNATURE');
});

test('a bad-signature attempt does not block the genuine event later', () => {
  const feed = new FeedIngest(SECRET);
  feed.ingest({ event, signature: 'f'.repeat(64) });
  assert.equal(feed.ingest(signWebhook(event, SECRET)).accepted, true);
});

test('stored evidence is a copy: mutating it cannot rewrite history', () => {
  const feed = new FeedIngest(SECRET);
  const { evidenceHash } = feed.ingest(signWebhook(event, SECRET));
  feed.evidence(evidenceHash).location = 'tampered';
  assert.ok(verifyEvidence(feed.evidence(evidenceHash), evidenceHash));
});

test('verifyEvidence detects any change to the bundle', () => {
  const h = hashEvidence(event);
  assert.ok(verifyEvidence(structuredClone(event), h));
  assert.ok(!verifyEvidence({ ...event, details: { a: 1, b: 3 } }, h));
});

test('constructor requires a secret', () => {
  assert.throws(() => new FeedIngest(''));
});
