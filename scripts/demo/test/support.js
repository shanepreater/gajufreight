import { installTemplates } from '../lib/shipment-escrow.js';

// Shared test setup. Every panel member must be a verified arbiter (ADR 0022), so tests that
// create quotes verify their arbiters first: the admin becomes the verifier (through `vote`,
// which defaults to one admin proposing on a one-admin platform) and records each address with
// the Arbiter role.
const FAR_FUTURE = 10 ** 9;

export function verifyArbiters(chain, platform, admin, arbiters, vote) {
  if (chain.view(platform, 'verifier') !== admin) {
    const change = { type: 'SetVerifier', verifier: admin };
    if (vote) vote(change);
    else chain.call(platform, 'propose', { change }, { caller: admin });
  }
  for (const account of arbiters) {
    chain.call(platform, 'verify', { account, commitment: 'c'.repeat(64), expires: FAR_FUTURE, roles: ['Arbiter'] }, { caller: admin });
  }
}

// Votes in a platform's quote and escrow templates on a one-admin platform, where a proposal
// applies at once (ADR 0011). Every quote and escrow is a clone of them.
export function installFor(chain, platform, admin) {
  return installTemplates(chain, platform, admin, (change) => chain.call(platform, 'propose', { change }, { caller: admin }));
}

// What an escrow paid out of the price and bond (not deposits or pass-through charges), in
// total or to one address. Payouts are balance changes on-chain, so the model logs them.
export const paidOut = (chain, id) => chain.transfers(id).filter((t) => t.kind === 'payout').reduce((sum, t) => sum + t.amount, 0n);
export const paidTo = (chain, id, to) => chain.transfers(id).filter((t) => t.kind === 'payout' && t.to === to).reduce((sum, t) => sum + t.amount, 0n);
