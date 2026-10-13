// JS model of Platform (docs/hld.md §5, ADR 0005, 0011): settings changed only by M-of-N
// admin approval; every quote and escrow cloned from a voted template; and the registry that
// tells genuine quotes, escrows and legs apart. Holds no money.
import { createHash } from 'node:crypto';
import { ContractError } from './errors.js';

const require = (ok, code) => {
  if (!ok) throw new ContractError(code);
};

// Fees (ADR 0018): fee_bps of the price with a minimum in puck (bigint), and bond_bps, the
// performance bond the payee stakes above the fee. confirm_window is in key blocks (≈ 1 day).
// Counts stay numbers; amounts are bigints, as on-chain.
export const MAX_FEE_BPS = 1000;
// Arbitration (ADR 0022): voting arbiters share arbiter_fee_bps of the disputed remainder, at
// least min_arbiter_fee; the raiser stakes the same as a deposit; a flagged dispute must be
// funded within deposit_window key blocks (≈ 3 days).
// max_price is the pilot cap in puck (0: none), and bookings_open (1 or 0) stops new quotes and
// bookings but never a live escrow (ADR 0011). A proposal stays open proposal_ttl key blocks.
export const DEFAULT_SETTINGS = Object.freeze({
  max_rounds: 3, max_panel: 7, max_attestors: 10, max_invited: 20, fee_bps: 100, min_fee: 10n ** 18n, bond_bps: 0,
  confirm_window: 480, arbiter_fee_bps: 200, min_arbiter_fee: 10n ** 18n, deposit_window: 1_440, max_price: 0n,
  bookings_open: 1, proposal_ttl: 3_360,
});

// What a verified organisation does (ADR 0019, 0022), mirroring ADR 0009's organisation kinds.
export const ROLES = Object.freeze(['Shipper', 'Forwarder', 'Carrier', 'FinalMile', 'Attestor', 'Arbiter']);

// Both rates are capped so a captured quorum can't take more than 10%; amounts can be 0.
function inBounds(key, value) {
  if (key === 'fee_bps' || key === 'bond_bps' || key === 'arbiter_fee_bps') return Number.isInteger(value) && value >= 0 && value <= MAX_FEE_BPS;
  if (key === 'min_fee' || key === 'max_price' || key === 'min_arbiter_fee') return typeof value === 'bigint' && value >= 0n;
  if (key === 'bookings_open') return value === 0 || value === 1;
  return Number.isInteger(value) && value >= 1;
}

const isAddress = (a) => typeof a === 'string' && a !== '';

// The salted fingerprint of a verified company (ADR 0019). On-chain it is Crypto.blake2b of
// the tuple; SHA-256 of the joined fields stands in for it here. Without the salt, guessing a
// company's registration number can't confirm which address is theirs.
export const verificationCommitment = ({ name, country, number, salt }) =>
  createHash('sha256').update(JSON.stringify([name, country, number, salt])).digest('hex');

const isCurrent = (s, account, height) => {
  const v = s.verifications[account];
  return Boolean(v) && !v.revoked && height <= v.expires;
};
const hasRole = (s, account, role, height) => isCurrent(s, account, height) && s.verifications[account].roles.includes(role);
const validRoles = (roles) => Array.isArray(roles) && roles.length > 0 && new Set(roles).size === roles.length && roles.every((r) => ROLES.includes(r));
// A change must be valid when proposed AND when it finally applies: state may have
// moved on in between (e.g. two removals that would together break the quorum).
function isValid(ctx, change) {
  const s = ctx.state;
  switch (change?.type) {
    case 'SetSetting':
      return Object.hasOwn(s.settings, change.key) && inBounds(change.key, change.value);
    case 'SetTreasury':
      return isAddress(change.treasury) && ctx.isPayable(change.treasury); // else every payout would fail (spike E6b)
    case 'SetVerifier':
      return isAddress(change.verifier);
    case 'SetEscrowTemplate':
    case 'SetQuoteTemplate':
      return ctx.isContract(change.template);
    case 'AddAdmin':
      return typeof change.admin === 'string' && !s.admins.includes(change.admin);
    case 'RemoveAdmin':
      return s.admins.includes(change.admin) && s.admins.length - 1 >= s.quorum;
    default:
      return false;
  }
}

function applyIfReady(ctx, id) {
  const s = ctx.state;
  const proposal = s.proposals[id];
  if (proposal.approvals.length < s.quorum) return;
  const { change } = proposal;
  require(isValid(ctx, change), 'BAD_SETTING');
  if (change.type === 'SetSetting') s.settings[change.key] = change.value;
  if (change.type === 'SetTreasury') s.treasury = change.treasury;
  if (change.type === 'SetVerifier') s.verifier = change.verifier;
  if (change.type === 'SetEscrowTemplate') s.escrowTemplate = change.template;
  if (change.type === 'SetQuoteTemplate') s.quoteTemplate = change.template;
  if (change.type === 'AddAdmin') s.admins.push(change.admin);
  if (change.type === 'RemoveAdmin') s.admins = s.admins.filter((a) => a !== change.admin);
  delete s.proposals[id];
  ctx.emit({ type: 'Applied', id });
}

export const Platform = {
  name: 'Platform',
  payable: ['book'],

  // The templates are deployed after the platform and voted in (ADR 0011).
  init(ctx, { admins, quorum, treasury }) {
    const unique = [...new Set(admins)];
    require(unique.length === admins.length && Number.isInteger(quorum) && quorum >= 1 && quorum <= unique.length, 'BAD_QUORUM');
    require(isAddress(treasury) && ctx.isPayable(treasury), 'BAD_TREASURY');
    return {
      admins: unique, quorum, treasury, verifier: null, verifications: {},
      escrowTemplate: null, quoteTemplate: null,
      quotes: {}, // every quote it cloned: true until booked
      escrows: {}, // every escrow it booked: { parent, price, released }
      legTotal: {}, // leg value booked against each main escrow
      settings: { ...DEFAULT_SETTINGS }, proposals: {}, nextId: 0,
    };
  },

  views: {
    is_quote: (s, { address }) => Object.hasOwn(s.quotes, address),
    is_escrow: (s, { address }) => Object.hasOwn(s.escrows, address),
    setting: (s, { key }) => s.settings[key],
    treasury: (s) => s.treasury,
    verifier: (s) => s.verifier,
    verification: (s, { account }) => s.verifications[account] ?? null,
    is_verified: (s, { account }, { blockHeight }) => isCurrent(s, account, blockHeight),
    has_role: (s, { account, role }, { blockHeight }) => hasRole(s, account, role, blockHeight),
    // Read by QuoteRequest when a quote swaps in an arbiter (ADR 0022).
    is_arbiter: (s, { account }, { blockHeight }) => hasRole(s, account, 'Arbiter', blockHeight),
    // A dry-run check of the details and salt a company shared (ADR 0019).
    matches: (s, { account, ...details }, { blockHeight }) =>
      isCurrent(s, account, blockHeight) && s.verifications[account].commitment === verificationCommitment(details),
  },

  entrypoints: {
    // An admin proposes a change; proposing counts as their approval.
    propose(ctx, { change }) {
      const s = ctx.state;
      require(s.admins.includes(ctx.caller), 'ONLY_ADMIN');
      require(isValid(ctx, change), 'BAD_SETTING');
      const id = s.nextId;
      s.nextId += 1;
      s.proposals[id] = { change, approvals: [ctx.caller], expires: ctx.blockHeight + s.settings.proposal_ttl };
      ctx.emit({ type: 'Proposed', id, proposer: ctx.caller });
      applyIfReady(ctx, id);
      return id;
    },

    // The verifier records that an address belongs to a verified business, until a block
    // height; verifying again renews the record and clears a revocation (ADR 0019).
    verify(ctx, { account, commitment, expires, roles }) {
      const s = ctx.state;
      require(ctx.caller === s.verifier, 'ONLY_VERIFIER');
      require(Number.isInteger(expires) && expires > ctx.blockHeight, 'BAD_EXPIRY');
      require(validRoles(roles), 'BAD_ROLES');
      s.verifications[account] = { commitment, expires, revoked: false, roles: [...roles] };
      ctx.emit({ type: 'Verified', account, expires });
    },

    revoke(ctx, { account }) {
      const s = ctx.state;
      require(ctx.caller === s.verifier, 'ONLY_VERIFIER');
      require(Object.hasOwn(s.verifications, account), 'NOT_VERIFIED');
      s.verifications[account].revoked = true;
      ctx.emit({ type: 'Revoked', account });
    },

    approve(ctx, { id }) {
      const s = ctx.state;
      require(s.admins.includes(ctx.caller), 'ONLY_ADMIN');
      require(Object.hasOwn(s.proposals, id), 'NO_PROPOSAL');
      require(ctx.blockHeight <= s.proposals[id].expires, 'PROPOSAL_EXPIRED'); // design audit F28
      const { approvals } = s.proposals[id];
      if (!approvals.includes(ctx.caller)) approvals.push(ctx.caller);
      applyIfReady(ctx, id);
    },

    // Clones the quote template; the caller becomes the requester (ADR 0011). A leg quote names
    // its parent: one of our main escrows, still open, paying the caller. The quote carries
    // today's fee and bond terms for the whole negotiation; a leg pays no fee (ADR 0018).
    new_quote(ctx, { invited, job, consignment, dispute, parent = null }) {
      const s = ctx.state;
      require(s.settings.bookings_open === 1, 'BOOKINGS_CLOSED');
      require(Array.isArray(invited) && invited.length <= s.settings.max_invited, 'BAD_INVITED');
      require(Array.isArray(dispute?.panel) && dispute.panel.length <= s.settings.max_panel, 'BAD_QUORUM');
      if (parent !== null) {
        const info = s.escrows[parent];
        require(info !== undefined, 'UNKNOWN_ESCROW');
        require(info.parent === null, 'NOT_MAIN');
        require(ctx.query(parent, 'payee') === ctx.caller, 'NOT_PAYEE');
        require(ctx.query(parent, 'is_open'), 'BAD_STATE');
      }
      require(s.quoteTemplate !== null, 'NO_TEMPLATE');
      // Only verified arbiters sit on a panel, so a party can't name accounts it controls (ADR 0022).
      require(dispute.panel.every((a) => hasRole(s, a, 'Arbiter', ctx.blockHeight)), 'UNVERIFIED_ARBITER');
      const isLeg = parent !== null;
      const fees = {
        feeBps: isLeg ? 0 : s.settings.fee_bps,
        minFee: isLeg ? 0n : s.settings.min_fee,
        bondBps: s.settings.bond_bps,
        confirmWindow: s.settings.confirm_window,
        arbiterFeeBps: s.settings.arbiter_fee_bps,
        minArbiterFee: s.settings.min_arbiter_fee,
        depositWindow: s.settings.deposit_window,
        treasury: s.treasury,
      };
      const quote = ctx.clone(s.quoteTemplate, { requester: ctx.caller, invited, job, consignment, dispute, maxRounds: s.settings.max_rounds, parent, fees });
      s.quotes[quote] = true;
      ctx.emit({ type: 'QuoteCreated', quote, requester: ctx.caller });
      return quote;
    },

    // Books and funds an escrow from an agreed quote in one call (ADR 0005, 0011): the clone's
    // init checks the agreement and the terms, and never calls back here, so this passes the
    // limits it needs. A leg's price counts against its parent's (ADR 0010).
    book(ctx, { quote, manifest, consignee = null }) {
      const s = ctx.state;
      require(s.settings.bookings_open === 1, 'BOOKINGS_CLOSED');
      require(Object.hasOwn(s.quotes, quote), 'UNKNOWN_QUOTE');
      require(s.quotes[quote], 'QUOTE_USED'); // one escrow per agreement (ADR 0004)
      s.quotes[quote] = false; // before any external call
      const agreement = ctx.query(quote, 'agreement');
      require(agreement !== null, 'NOT_AGREED');
      const { price } = agreement.terms;
      const parent = ctx.query(quote, 'parent');
      if (parent !== null) {
        const total = (s.legTotal[parent] ?? 0n) + price;
        require(total <= s.escrows[parent].price, 'LEG_TOO_LARGE');
        s.legTotal[parent] = total;
      }
      require(s.escrowTemplate !== null, 'NO_TEMPLATE');
      const escrow = ctx.clone(s.escrowTemplate, {
        shipper: ctx.caller, quote, manifest, consignee,
        maxPanel: s.settings.max_panel, maxAttestors: s.settings.max_attestors, maxPrice: s.settings.max_price,
      }, ctx.value);
      s.escrows[escrow] = { parent, price, released: false };
      ctx.emit({ type: 'EscrowBooked', escrow, quote, payer: ctx.caller });
      return escrow;
    },

    // Once a leg ends, anyone can return the part of its price never paid to its carrier to the
    // parent's leg budget, once, so a failed carrier can be replaced (ADR 0011). A pull: no
    // refund path ever depends on a call into the platform.
    release_leg(ctx, { leg }) {
      const s = ctx.state;
      const info = s.escrows[leg];
      require(info !== undefined && info.parent !== null, 'NOT_LEG');
      require(!info.released, 'LEG_RELEASED');
      require(ctx.query(leg, 'is_terminal'), 'LEG_OPEN');
      const returned = info.price - ctx.query(leg, 'paid_to_payee');
      info.released = true;
      s.legTotal[info.parent] -= returned;
      ctx.emit({ type: 'LegReleased', leg, returned });
    },
  },
};
