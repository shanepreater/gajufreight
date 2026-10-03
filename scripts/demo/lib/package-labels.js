// Package QR labels and manifests (ADR 0003). A label only IDENTIFIES a package;
// custody is recorded when an attestor signs a checkpoint. Labels hold no secrets.
import { ContractError } from './errors.js';
import { hashEvidence } from './shipping-feed.js';

const SCHEME = 'gajufreight://';
const PACKAGE_ID = /^[A-Z0-9][A-Z0-9-]{0,31}$/; // printed under the QR, so keep it readable
const CONTRACT_ID = /^[A-Za-z0-9_]+$/;
const LABEL = /^gajufreight:\/\/s\/([A-Za-z0-9_]+)\/p\/([^/]+)$/;
const isPackageId = (id) => typeof id === 'string' && PACKAGE_ID.test(id);

// Label and manifest problems reuse ContractError so the demo reports them uniformly.
const fail = (code) => {
  throw new ContractError(code);
};

// Validates exactly what parseLabel accepts, so every encoded label parses back.
export function encodeLabel(contract, packageId) {
  if (typeof contract !== 'string' || !CONTRACT_ID.test(contract) || !isPackageId(packageId)) fail('BAD_LABEL');
  return `${SCHEME}s/${contract}/p/${packageId}`;
}

export function parseLabel(text) {
  if (typeof text !== 'string') fail('BAD_LABEL');
  const match = LABEL.exec(text.trim());
  if (!match || !isPackageId(match[2])) fail('BAD_LABEL');
  return { contract: match[1], packageId: match[2] };
}

// Sorted by id so the hash does not depend on the order packages were entered.
export function buildManifest(packages) {
  if (!Array.isArray(packages) || packages.length === 0) fail('BAD_MANIFEST');
  const ids = packages.map((p) => p.id);
  if (!ids.every(isPackageId) || new Set(ids).size !== ids.length) fail('BAD_MANIFEST');
  const sorted = [...packages].sort((a, b) => a.id.localeCompare(b.id));
  return { packages: sorted.map(({ id, description }) => ({ id, description })) };
}

export const manifestHash = (manifest) => hashEvidence(manifest);
