// JS model of Platform (docs/hld.md §5, ADR 0005): settings changed only by M-of-N
// admin approval, and the registry of every QuoteRequest it created. Holds no money.
import { ContractError } from './errors.js';
import { QuoteRequest } from './quote-request.js';

const require = (ok, code) => {
  if (!ok) throw new ContractError(code);
};

export const DEFAULT_SETTINGS = Object.freeze({ max_rounds: 5, max_panel: 7 });

// A change must be valid when proposed AND when it finally applies: state may have
// moved on in between (e.g. two removals that would together break the quorum).
function isValid(s, change) {
  switch (change?.type) {
    case 'SetSetting':
      return Object.hasOwn(s.settings, change.key) && Number.isInteger(change.value) && change.value >= 1;
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
  if (change.type === 'AddAdmin') s.admins.push(change.admin);
  if (change.type === 'RemoveAdmin') s.admins = s.admins.filter((a) => a !== change.admin);
  delete s.proposals[id];
  ctx.emit({ type: 'Applied', id, change });
}

export const Platform = {
  name: 'Platform',
  payable: [],

  init(ctx, { admins, quorum }) {
    const unique = [...new Set(admins)];
    require(unique.length === admins.length && Number.isInteger(quorum) && quorum >= 1 && quorum <= unique.length, 'BAD_QUORUM');
    return { admins: unique, quorum, settings: { ...DEFAULT_SETTINGS }, proposals: {}, nextId: 0, quotes: [] };
  },

  views: {
    is_quote: (s, { address }) => s.quotes.includes(address),
    setting: (s, { key }) => s.settings[key],
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
    new_quote(ctx, { invited, job }) {
      const s = ctx.state;
      const quote = ctx.create(QuoteRequest, { requester: ctx.caller, invited, job, maxRounds: s.settings.max_rounds });
      s.quotes.push(quote);
      ctx.emit({ type: 'QuoteCreated', quote, requester: ctx.caller });
      return quote;
    },
  },
};
