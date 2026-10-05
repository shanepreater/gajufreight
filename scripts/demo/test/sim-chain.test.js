import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain, FINALITY_KEYBLOCKS } from '../lib/sim-chain.js';
import { ContractError } from '../lib/errors.js';

// Minimal contract used only to exercise the chain mechanics.
const Counter = {
  name: 'Counter',
  payable: ['deposit'],
  init: () => ({ n: 0 }),
  views: {
    count: (state) => state.n,
    snapshot: (state) => state,
  },
  entrypoints: {
    readOther(ctx, { other }) {
      ctx.state.n = ctx.query(other, 'count') + 100;
    },
    inc(ctx) {
      ctx.state.n += 1;
      ctx.emit({ type: 'Inc' });
    },
    deposit() {},
    incThenFail(ctx) {
      ctx.state.n += 1;
      ctx.emit({ type: 'Inc' });
      throw new ContractError('BOOM');
    },
    payOut(ctx, { to, amount }) {
      ctx.spend(to, amount);
    },
  },
};

function setup() {
  const chain = new SimChain();
  const alice = chain.createAccount('alice', 100n);
  const bob = chain.createAccount('bob', 0n);
  const { result: id } = chain.deploy(Counter, alice, {});
  return { chain, alice, bob, id };
}

test('successful call updates state and emits event', () => {
  const { chain, alice, id } = setup();
  chain.call(id, 'inc', {}, { caller: alice });
  assert.equal(chain.contractState(id).n, 1);
  assert.equal(chain.events(id).length, 1);
});

test('failed call reverts state, events and balances atomically', () => {
  const { chain, alice, id } = setup();
  assert.throws(() => chain.call(id, 'incThenFail', {}, { caller: alice, value: 0n }), { code: 'BOOM' });
  assert.equal(chain.contractState(id).n, 0);
  assert.equal(chain.events(id).length, 0);
  assert.equal(chain.balanceOf(alice), 100n);
});

test('value sent to a non-payable entrypoint is rejected and refunded', () => {
  const { chain, alice, id } = setup();
  assert.throws(() => chain.call(id, 'inc', {}, { caller: alice, value: 5n }), { code: 'NOT_PAYABLE' });
  assert.equal(chain.balanceOf(alice), 100n);
  assert.equal(chain.balanceOf(id), 0n);
});

test('payable entrypoint moves value into the contract', () => {
  const { chain, alice, id } = setup();
  chain.call(id, 'deposit', {}, { caller: alice, value: 40n });
  assert.equal(chain.balanceOf(alice), 60n);
  assert.equal(chain.balanceOf(id), 40n);
});

test('overspending caller is rejected with INSUFFICIENT_BALANCE', () => {
  const { chain, alice, id } = setup();
  assert.throws(() => chain.call(id, 'deposit', {}, { caller: alice, value: 101n }), { code: 'INSUFFICIENT_BALANCE' });
  assert.equal(chain.balanceOf(alice), 100n);
});

test('contract cannot spend more than it holds', () => {
  const { chain, alice, bob, id } = setup();
  chain.call(id, 'deposit', {}, { caller: alice, value: 10n });
  assert.throws(() => chain.call(id, 'payOut', { to: bob, amount: 11n }, { caller: alice }), { code: 'INSUFFICIENT_BALANCE' });
  assert.equal(chain.balanceOf(id), 10n);
});

test('unknown contract, entrypoint and account are rejected', () => {
  const { chain, alice, id } = setup();
  assert.throws(() => chain.call('ct_nope', 'inc', {}, { caller: alice }), { code: 'UNKNOWN_CONTRACT' });
  assert.throws(() => chain.call(id, 'nope', {}, { caller: alice }), { code: 'UNKNOWN_ENTRYPOINT' });
  assert.throws(() => chain.call(id, 'inc', {}, { caller: 'ak_ghost' }), { code: 'UNKNOWN_ACCOUNT' });
});

test('receipt is pending until exactly FINALITY_KEYBLOCKS keyblocks pass', () => {
  const { chain, alice, id } = setup();
  const { txHash } = chain.call(id, 'inc', {}, { caller: alice });
  assert.equal(chain.receiptStatus(txHash), 'pending');
  chain.advanceKeyblocks(FINALITY_KEYBLOCKS - 1);
  assert.equal(chain.receiptStatus(txHash), 'pending');
  chain.advanceKeyblocks(1);
  assert.equal(chain.receiptStatus(txHash), 'final');
});

test('dropping the last microblock undoes its effects and marks it dropped', () => {
  const { chain, alice, id } = setup();
  const { txHash } = chain.call(id, 'inc', {}, { caller: alice });
  assert.equal(chain.dropLastMicroblock(), txHash);
  assert.equal(chain.receiptStatus(txHash), 'dropped');
  assert.equal(chain.contractState(id).n, 0);
  assert.equal(chain.events(id).length, 0);
});

test('a final microblock cannot be dropped', () => {
  const { chain, alice, id } = setup();
  chain.call(id, 'inc', {}, { caller: alice });
  chain.advanceKeyblocks(FINALITY_KEYBLOCKS);
  assert.throws(() => chain.dropLastMicroblock(), /final/);
});

test('total supply is constant across transfers and reverts', () => {
  const { chain, alice, bob, id } = setup();
  const supply = chain.totalSupply();
  chain.call(id, 'deposit', {}, { caller: alice, value: 30n });
  chain.call(id, 'payOut', { to: bob, amount: 30n }, { caller: alice });
  assert.throws(() => chain.call(id, 'deposit', {}, { caller: bob, value: 31n }));
  assert.equal(chain.totalSupply(), supply);
});

test('advanceKeyblocks rejects negative and fractional counts', () => {
  const chain = new SimChain();
  assert.throws(() => chain.advanceKeyblocks(-1));
  assert.throws(() => chain.advanceKeyblocks(1.5));
});

test('view returns a copy of contract state and cannot mutate it', () => {
  const { chain, alice, id } = setup();
  chain.call(id, 'inc', {}, { caller: alice });
  assert.equal(chain.view(id, 'count'), 1);
  chain.view(id, 'snapshot').n = 999;
  assert.equal(chain.view(id, 'count'), 1);
});

test('unknown views and contracts are rejected', () => {
  const { chain, id } = setup();
  assert.throws(() => chain.view(id, 'nope'), { code: 'UNKNOWN_ENTRYPOINT' });
  assert.throws(() => chain.view('ct_nope', 'count'), { code: 'UNKNOWN_CONTRACT' });
});

test('a contract can query another contract read-only during a call', () => {
  const { chain, alice, id } = setup();
  const { result: other } = chain.deploy(Counter, alice, {});
  chain.call(other, 'inc', {}, { caller: alice });
  chain.call(id, 'readOther', { other }, { caller: alice });
  assert.equal(chain.view(id, 'count'), 101);
  assert.equal(chain.view(other, 'count'), 1);
});

describe('value at deploy and contract-created contracts (ADR 0005)', () => {
  const Vault = {
    name: 'Vault',
    payableInit: true,
    payable: [],
    // Records what init sees: Call.value and Contract.balance (spike E2b).
    init: (ctx) => ({ got: ctx.balance(), callValue: ctx.value, creator: ctx.caller }),
    views: { got: (s) => s.got, callValue: (s) => s.callValue, creator: (s) => s.creator },
    entrypoints: {},
  };
  const Factory = {
    name: 'Factory',
    init: () => ({ made: [] }),
    views: { made: (s) => s.made },
    entrypoints: {
      make(ctx) {
        const id = ctx.create(Vault, {});
        ctx.state.made.push(id);
        return id;
      },
      makeThenFail(ctx) {
        ctx.create(Vault, {});
        throw new ContractError('BOOM');
      },
    },
  };

  test('value at deploy is rejected for contracts without a payable init (NOT_PAYABLE)', () => {
    const chain = new SimChain();
    const alice = chain.createAccount('alice', 100n);
    const Plain = { ...Vault, payableInit: false };
    assert.throws(() => chain.deploy(Plain, alice, {}, { value: 1n }), { code: 'NOT_PAYABLE' });
    assert.equal(chain.balanceOf(alice), 100n);
  });

  test('negative or non-BigInt deploy values are rejected (BAD_VALUE)', () => {
    const chain = new SimChain();
    const alice = chain.createAccount('alice', 100n);
    for (const value of [-1n, 5]) assert.throws(() => chain.deploy(Vault, alice, {}, { value }), { code: 'BAD_VALUE' });
  });

  test('deploy can carry value: init sees it in its balance, with Call.value 0 (as on testnet, spike E2b)', () => {
    const chain = new SimChain();
    const alice = chain.createAccount('alice', 100n);
    const { result: id } = chain.deploy(Vault, alice, {}, { value: 40n });
    assert.equal(chain.balanceOf(id), 40n);
    assert.equal(chain.balanceOf(alice), 60n);
    assert.equal(chain.view(id, 'got'), 40n);
    assert.equal(chain.view(id, 'callValue'), 0n);
  });

  test('deploy value beyond the balance is rejected and nothing is created', () => {
    const chain = new SimChain();
    const alice = chain.createAccount('alice', 10n);
    assert.throws(() => chain.deploy(Vault, alice, {}, { value: 11n }), { code: 'INSUFFICIENT_BALANCE' });
    assert.equal(chain.totalSupply(), 10n);
  });

  test('a failing init returns the deploy value', () => {
    const chain = new SimChain();
    const alice = chain.createAccount('alice', 50n);
    const Picky = { ...Vault, init: () => { throw new ContractError('NOPE'); } };
    assert.throws(() => chain.deploy(Picky, alice, {}, { value: 5n }), { code: 'NOPE' });
    assert.equal(chain.balanceOf(alice), 50n);
  });

  test('a contract can create another; the creator is the calling contract', () => {
    const chain = new SimChain();
    const alice = chain.createAccount('alice', 0n);
    const { result: factory } = chain.deploy(Factory, alice, {});
    const { result: child } = chain.call(factory, 'make', {}, { caller: alice });
    assert.equal(chain.view(child, 'creator'), factory);
    assert.deepEqual(chain.view(factory, 'made'), [child]);
  });

  test('a contract created inside a failed call does not exist afterwards', () => {
    const chain = new SimChain();
    const alice = chain.createAccount('alice', 0n);
    const { result: factory } = chain.deploy(Factory, alice, {});
    assert.throws(() => chain.call(factory, 'makeThenFail', {}, { caller: alice }), { code: 'BOOM' });
    assert.deepEqual(chain.view(factory, 'made'), []);
  });
});
