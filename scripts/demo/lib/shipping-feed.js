// PLACEHOLDER for services/api evidence ingest. External shipping feeds are
// untrusted: webhooks must carry a valid HMAC signature, are deduplicated by
// event id, and are only stored off-chain. The chain sees just the evidence hash.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const hashEvidence = (bundle) => createHash('sha256').update(canonicalJson(bundle)).digest('hex');
export const verifyEvidence = (bundle, hash) => hashEvidence(bundle) === hash;

const hmac = (event, secret) => createHmac('sha256', secret).update(canonicalJson(event)).digest('hex');

export function signWebhook(event, secret) {
  return { event: structuredClone(event), signature: hmac(event, secret) };
}

export class FeedIngest {
  #secret;
  #seen = new Set();
  #store = new Map();

  constructor(secret) {
    if (!secret) throw new Error('feed secret required');
    this.#secret = secret;
  }

  ingest({ event, signature } = {}) {
    if (!event || typeof event.id !== 'string') return { accepted: false, reason: 'BAD_SIGNATURE' };
    const expected = hmac(event, this.#secret);
    const valid =
      typeof signature === 'string' &&
      /^[0-9a-f]{64}$/.test(signature) &&
      timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    if (!valid) return { accepted: false, reason: 'BAD_SIGNATURE' };
    if (this.#seen.has(event.id)) return { accepted: false, reason: 'DUPLICATE' };
    this.#seen.add(event.id);
    const evidenceHash = hashEvidence(event);
    this.#store.set(evidenceHash, structuredClone(event));
    return { accepted: true, evidenceHash };
  }

  hasEvent(id) {
    return this.#seen.has(id);
  }

  evidence(hash) {
    const e = this.#store.get(hash);
    return e ? structuredClone(e) : null;
  }
}
