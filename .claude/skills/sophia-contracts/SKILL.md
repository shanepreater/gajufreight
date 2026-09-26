---
name: sophia-contracts
description: Sophia smart-contract specialist for GajuFreight. Use when writing, reviewing, testing or deploying anything under contracts/ (.aes files), changing the shipment lifecycle, roles or escrow logic, or answering questions about Sophia/FATE behaviour on Gajumaru.
---

# Sophia contracts specialist

You own `contracts/`. The contract is the product: money and shipment status live here, and everything else is a view of it.

## Before editing

1. Read [docs/hld.md](../../../docs/hld.md) §4 (lifecycle), §5 (sketch) and §6 (decisions).
2. Re-read the **Contract invariants** in [AGENTS.md](../../../AGENTS.md). Every change must keep them.
3. If the change depends on `Chain.clone`, Data TTL or protected-account payouts, check [HLD §7](../../../docs/hld.md#7-open-questions). If it's still open there, stop and report.

## Entrypoint pattern

Order inside every `stateful` entrypoint:

```sophia
stateful entrypoint do_thing(arg : t) =
  require(<caller role check>, "ONLY_ROLE")      // 1. who
  require(<status check>, "BAD_STATE")           // 2. when
  require(<argument checks>, "BAD_ARG")          // 3. what
  put(state{ ... })                              // 4. update state
  Chain.spend(recipient, amount)                 // 5. move value last
```

- Use `payable` only on entrypoints that accept value (`fund`). Check `Call.value` exactly.
- Error strings are `UPPER_SNAKE` and stable. Tests and the UI match on them.
- Keep helpers as private `function`s. Only real API surface should be an `entrypoint`.
- Emit events (`datatype event` + `Chain.event`) for every status change so the indexer doesn't have to poll state.

## Sophia and FATE pitfalls

- Sophia has no floats. Work in the smallest Gaju denomination and do multiplication before division (`amount * pct / 100`). Make sure any rounding remainder goes somewhere definite (the shipper) so funds are conserved.
- Time: use `Chain.block_height` for deadlines. `Chain.timestamp` is milliseconds and only suitable for display.
- Lists are linked lists: prepend with `::`, and avoid `List.length` or loops over lists that grow without bound in entrypoints. Keep `checkpoints` to milestones only.
- Use a `map` when you need to look something up by key. `Map.member` / `Map.lookup` return an `option`, so handle `None`.
- Library modules need `include "List.aes"`, `"Option.aes"`, etc.
- `state` must be `record state`, and `init` returns it. Don't name a datatype `state`.
- Remote calls: `c.fn(value = x, gas = g)`. Treat the callee as untrusted and put state before value (see the pattern above).
- Pin the compiler: `@compiler >= X` (keep X in sync with the toolchain in CI).

## Testing (required for every change)

- One happy-path test per lifecycle path: deliver, dispute → resolve, deadline → refund.
- One rejection test per `require`: wrong caller, wrong status, bad argument.
- Property test of fund conservation over random call sequences: `carrier_paid + shipper_refunded == funded` in every terminal state.
- Tests run against the local demo chain (`infra/local-chain`).

## Review checklist

- [ ] Every state-changing entrypoint checks role and status.
- [ ] Terminal states (`Released`, `Refunded`, `Resolved`) can't be left.
- [ ] No path lets a single party freeze funds indefinitely.
- [ ] No iteration over unbounded data in entrypoints.
- [ ] Only hashes on-chain. No personal data or raw documents.
- [ ] Events emitted. The HLD is updated if the lifecycle changed.

References: [sophia-language.com](https://sophia-language.com/) · [docs/sources.md](../../../docs/sources.md)
