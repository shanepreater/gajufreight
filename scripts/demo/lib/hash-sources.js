// What the demo hashed to get a value the contracts compute for themselves: a job is
// Crypto.blake2b((manifest, consignee)), a quote's terms hash is blake2b of its terms, a
// verification commitment is blake2b of the company's details. The demo hashes them with
// SHA-256 instead, so a replay on a chain rebuilds them from what they were made of (#70).
const sources = new Map();

export function remember(hash, kind, of) {
  sources.set(hash, { kind, of });
  return hash;
}

export const sourceOf = (hash) => sources.get(hash) ?? null;
