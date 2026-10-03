// Package QR labels and manifests (ADR 0003). A label only IDENTIFIES a package;
// custody is recorded when an attestor signs a checkpoint. Labels hold no secrets.
import { ContractError } from './errors.js';
import { hashEvidence } from './shipping-feed.js';

const SCHEME = 'gajufreight://';
const PACKAGE_ID = /^[A-Z0-9][A-Z0-9-]{0,31}$/; // printed under the QR, so keep it readable
const LABEL = /^gajufreight:\/\/s\/([A-Za-z0-9_]+)\/p\/([^/]+)$/;

// Label and manifest problems reuse ContractError so the demo reports them uniformly.
const fail = (code) => {
  throw new ContractError(code);
};

export function encodeLabel(contract, packageId) {
  if (!PACKAGE_ID.test(packageId)) fail('BAD_LABEL');
  return `${SCHEME}s/${contract}/p/${packageId}`;
}

export function parseLabel(text) {
  if (typeof text !== 'string') fail('BAD_LABEL');
  const match = LABEL.exec(text.trim());
  if (!match || !PACKAGE_ID.test(match[2])) fail('BAD_LABEL');
  return { contract: match[1], packageId: match[2] };
}

// Sorted by id so the hash does not depend on the order packages were entered.
export function buildManifest(packages) {
  if (!Array.isArray(packages) || packages.length === 0) fail('BAD_MANIFEST');
  const ids = packages.map((p) => p.id);
  if (!ids.every((id) => PACKAGE_ID.test(id)) || new Set(ids).size !== ids.length) fail('BAD_MANIFEST');
  const sorted = [...packages].sort((a, b) => a.id.localeCompare(b.id));
  return { packages: sorted.map(({ id, description }) => ({ id, description })) };
}

export const manifestHash = (manifest) => hashEvidence(manifest);
