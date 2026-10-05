// JS model of Platform (docs/hld.md §5, ADR 0005): settings changed only by M-of-N
// admin approval, and the registry of every QuoteRequest it created. Holds no money.
import { ContractError } from './errors.js';
import { QuoteRequest } from './quote-request.js';

const require = (ok, code) => {
  if (!ok) throw new ContractError(code);
};

// Fees (ADR 0010): fee_bps in basis points of each payout to the payee, with a minimum
// in puck (bigint). Counts stay numbers; amounts are bigints, as on-chain.
export const MAX_FEE_BPS = 1000;
export const DEFAULT_SETTINGS = Object.freeze({ max_rounds: 5, max_panel: 7, fee_bps: 100, min_fee: 10n ** 18n });

// The fee is capped so a captured quorum can't take more than 10%; amounts can be 0.
function inBounds(key, value) {
  if (key === 'fee_bps') return Number.isInteger(value) && value >= 0 && value <= MAX_FEE_BPS;
  if (key === 'min_fee') return typeof value === 'bigint' && value >= 0n;
  return Number.isInteger(value) && value >= 1;
}

const isAddress = (a) => typeof a === 'string' && a !== '';

// A change must be valid when proposed AND when it finally applies: state may have
// moved on in between (e.g. two removals that would together break the quorum).
function isValid(s, change) {
  switch (change?.type) {
    case 'SetSetting':
      return Object.hasOwn(s.settings, change.key) && inBounds(change.key, change.value);
    case 'SetTreasury':
      return isAddress(change.treasury);
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
    return { admins: unique, quorum, treasury, escrowCode: null, settings: { ...DEFAULT_SETTINGS }, proposals: {}, nextId: 0, quotes: {} }; // quotes: address -> true
  },

  views: {
    is_quote: (s, { address }) => Object.hasOwn(s.quotes, address),
    setting: (s, { key }) => s.settings[key],
    treasury: (s) => s.treasury,
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

    approve(ctx, { id }) {
      const s = ctx.state;
      require(s.admins.includes(ctx.caller), 'ONLY_ADMIN');
      require(Object.hasOwn(s.proposals, id), 'NO_PROPOSAL');
      const { approvals } = s.proposals[id];
      if (!approvals.includes(ctx.caller)) approvals.push(ctx.caller);
      applyIfReady(ctx, id);
    },

    // Chain.create from a contract (HLD §7 Q12): the caller becomes the quote's requester.
    // A leg quote names its parent: one of our escrows (by bytecode hash), still open,
    // paying the caller. Escrows from leg quotes pay no fee (ADR 0010).
    new_quote(ctx, { invited, job, parent = null }) {
      const s = ctx.state;
      if (parent !== null) {
        require(s.escrowCode !== null && ctx.bytecodeHash(parent) === s.escrowCode, 'UNKNOWN_ESCROW');
        require(ctx.query(parent, 'payee') === ctx.caller, 'NOT_PAYEE');
        require(ctx.query(parent, 'is_open'), 'BAD_STATE');
      }
      const quote = ctx.create(QuoteRequest, { requester: ctx.caller, invited, job, maxRounds: s.settings.max_rounds, parent });
      s.quotes[quote] = true;
      ctx.emit({ type: 'QuoteCreated', quote, requester: ctx.caller });
      return quote;
    },
  },
};
