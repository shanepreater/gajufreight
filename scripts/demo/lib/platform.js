// JS model of Platform (docs/hld.md §5, ADR 0005): settings changed only by M-of-N
// admin approval, and the registry of every QuoteRequest it created. Holds no money.
import { createHash } from 'node:crypto';
import { ContractError } from './errors.js';
import { QuoteRequest } from './quote-request.js';

const require = (ok, code) => {
  if (!ok) throw new ContractError(code);
};

// Fees (ADR 0018): fee_bps of the price with a minimum in puck (bigint), and bond_bps, the
// performance bond the payee stakes above the fee. confirm_window is in key blocks (≈ 1 day).
// Counts stay numbers; amounts are bigints, as on-chain.
export const MAX_FEE_BPS = 1000;
export const DEFAULT_SETTINGS = Object.freeze({ max_rounds: 3, max_panel: 7, fee_bps: 100, min_fee: 10n ** 18n, bond_bps: 0, confirm_window: 480 });

// Both rates are capped so a captured quorum can't take more than 10%; amounts can be 0.
function inBounds(key, value) {
  if (key === 'fee_bps' || key === 'bond_bps') return Number.isInteger(value) && value >= 0 && value <= MAX_FEE_BPS;
  if (key === 'min_fee') return typeof value === 'bigint' && value >= 0n;
  return Number.isInteger(value) && value >= 1;
}

const isAddress = (a) => typeof a === 'string' && a !== '';

// The salted fingerprint of a verified company (ADR 0019). On-chain it is Crypto.blake2b of
// the tuple; SHA-256 of the joined fields stands in for it here. Without the salt, guessing a
// company's registration number can't confirm which address is theirs.
export const verificationCommitment = ({ name, country, number, salt }) =>
  createHash('sha256').update(JSON.stringify([name, country, number, salt])).digest('hex');

const isCurrent = (record, height) => record !== null && !record.revoked && height <= record.expires;
const isOurEscrow = (ctx, address) => ctx.state.escrowCode !== null && ctx.bytecodeHash(address) === ctx.state.escrowCode;

// A change must be valid when proposed AND when it finally applies: state may have
// moved on in between (e.g. two removals that would together break the quorum).
function isValid(s, change) {
  switch (change?.type) {
    case 'SetSetting':
      return Object.hasOwn(s.settings, change.key) && inBounds(change.key, change.value);
    case 'SetTreasury':
      return isAddress(change.treasury);
    case 'SetVerifier':
      return isAddress(change.verifier);
    case 'SetEscrowCode':
      return typeof change.hash === 'string' && change.hash !== '';
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
  require(isValid(s, change), 'BAD_SETTING');
  if (change.type === 'SetSetting') s.settings[change.key] = change.value;
  if (change.type === 'SetTreasury') s.treasury = change.treasury;
  if (change.type === 'SetVerifier') s.verifier = change.verifier;
  if (change.type === 'SetEscrowCode') s.escrowCode = change.hash;
  if (change.type === 'AddAdmin') s.admins.push(change.admin);
  if (change.type === 'RemoveAdmin') s.admins = s.admins.filter((a) => a !== change.admin);
  delete s.proposals[id];
  ctx.emit({ type: 'Applied', id, change });
}

export const Platform = {
  name: 'Platform',
  payable: [],

  // The escrow template's hash is voted in after the template is built for this platform.
  init(ctx, { admins, quorum, treasury }) {
    const unique = [...new Set(admins)];
    require(unique.length === admins.length && Number.isInteger(quorum) && quorum >= 1 && quorum <= unique.length, 'BAD_QUORUM');
    require(isAddress(treasury), 'BAD_TREASURY');
    return { admins: unique, quorum, treasury, verifier: null, verifications: {}, escrowCode: null, legTotal: {}, settings: { ...DEFAULT_SETTINGS }, proposals: {}, nextId: 0, quotes: {} }; // quotes: address -> true
  },

  views: {
    is_quote: (s, { address }) => Object.hasOwn(s.quotes, address),
    setting: (s, { key }) => s.settings[key],
    treasury: (s) => s.treasury,
    verifier: (s) => s.verifier,
    verification: (s, { account }) => s.verifications[account] ?? null,
    is_verified: (s, { account }, { blockHeight }) => isCurrent(s.verifications[account] ?? null, blockHeight),
    // Anyone the company gives its details and salt to can check them, as a dry run: the
    // details never go on-chain (ADR 0019).
    matches: (s, { account, ...details }) => s.verifications[account]?.commitment === verificationCommitment(details),
  },

  entrypoints: {
    // An admin proposes a change; proposing counts as their approval.
    propose(ctx, { change }) {
      const s = ctx.state;
      require(s.admins.includes(ctx.caller), 'ONLY_ADMIN');
      require(isValid(s, change), 'BAD_SETTING');
      const id = s.nextId;
      s.nextId += 1;
      s.proposals[id] = { change, approvals: [ctx.caller] };
      ctx.emit({ type: 'Proposed', id, change });
      applyIfReady(ctx, id);
      return id;
    },

    // The verifier records that an address belongs to a verified business, until a block
    // height; verifying again renews the record and clears a revocation (ADR 0019).
    verify(ctx, { account, commitment, expires }) {
      const s = ctx.state;
      require(s.verifier !== null && ctx.caller === s.verifier, 'ONLY_VERIFIER');
      require(Number.isInteger(expires) && expires > ctx.blockHeight, 'BAD_EXPIRY');
      s.verifications[account] = { commitment, verifiedAt: ctx.blockHeight, expires, revoked: false };
      ctx.emit({ type: 'Verified', account, expires });
    },

    revoke(ctx, { account }) {
      const s = ctx.state;
      require(s.verifier !== null && ctx.caller === s.verifier, 'ONLY_VERIFIER');
      require(Object.hasOwn(s.verifications, account), 'NOT_VERIFIED');
      s.verifications[account].revoked = true;
      ctx.emit({ type: 'Revoked', account });
    },

    approve(ctx, { id }) {
      const s = ctx.state;
      require(s.admins.includes(ctx.caller), 'ONLY_ADMIN');
      require(Object.hasOwn(s.proposals, id), 'NO_PROPOSAL');
      const { approvals } = s.proposals[id];
      if (!approvals.includes(ctx.caller)) approvals.push(ctx.caller);
      applyIfReady(ctx, id);
    },

    // Chain.create from a contract (HLD §7 Q12): the caller becomes the quote's requester.
    // A leg quote names its parent: one of our main escrows (by bytecode hash), still open,
    // paying the caller. The quote carries today's fee and bond terms for the whole negotiation;
    // a leg pays no fee (ADR 0018).
    new_quote(ctx, { invited, job, consignment, dispute, parent = null }) {
      const s = ctx.state;
      require(Array.isArray(dispute?.panel) && dispute.panel.length <= s.settings.max_panel, 'BAD_QUORUM');
      if (parent !== null) {
        require(isOurEscrow(ctx, parent), 'UNKNOWN_ESCROW');
        require(!ctx.query(parent, 'is_leg'), 'NOT_MAIN');
        require(ctx.query(parent, 'payee') === ctx.caller, 'NOT_PAYEE');
        require(ctx.query(parent, 'is_open'), 'BAD_STATE');
      }
      const isLeg = parent !== null;
      const fees = {
        feeBps: isLeg ? 0 : s.settings.fee_bps,
        minFee: isLeg ? 0n : s.settings.min_fee,
        bondBps: s.settings.bond_bps,
        confirmWindow: s.settings.confirm_window,
        treasury: s.treasury,
      };
      const quote = ctx.create(QuoteRequest, { requester: ctx.caller, invited, job, consignment, dispute, maxRounds: s.settings.max_rounds, parent, fees });
      s.quotes[quote] = true;
      ctx.emit({ type: 'QuoteCreated', quote, requester: ctx.caller });
      return quote;
    },

    // Called by a leg escrow's init. Only our escrow template can call it, and a parent's
    // legs together can't exceed its price, so a small parent can't back unlimited legs.
    add_leg(ctx, { parent, price }) {
      const s = ctx.state;
      require(isOurEscrow(ctx, ctx.caller), 'UNKNOWN_ESCROW');
      const total = (s.legTotal[parent] ?? 0n) + price;
      require(total <= ctx.query(parent, 'price'), 'LEG_TOO_LARGE');
      s.legTotal[parent] = total;
    },
  },
};
