---
name: backend-services
description: Backend specialist for GajuFreight services. Use for services/api (booking, GRIDS payload building, evidence ingest and hashing, external feed webhooks) and services/indexer (microblock watcher, read model, finality tracking).
---

# Backend services specialist

You own `services/`. Read [docs/architecture-blueprint.md](../../../docs/architecture-blueprint.md) §3–4 and [docs/hld.md](../../../docs/hld.md) §6.3–6.5 first.

> The service language hasn't been chosen yet (dev-approach phase 0 depends on which Gajumaru client libraries exist). Until then these rules are language-neutral.

## API (`services/api`)

- **Builds, never signs.** Endpoints return unsigned transactions encoded as GRIDS payloads. There's no signing path with user keys.
- **Stateless.** Any state lives in the read model or evidence store. Horizontal scaling must just work.
- **Evidence ingest:** store the raw file in the content-addressed evidence store, compute the hash, and return it for `add_checkpoint` / `confirm_delivery`. Never put raw evidence on-chain.
- **External feeds** (carrier TMS, ports, IoT) are untrusted. Verify webhook signatures, make handlers idempotent (dedupe on event id), and have them only *prompt* an attestor to sign. They never change status themselves.
- Validate every input at the edge. Return stable error codes.

## Indexer (`services/indexer`)

- Watch microblocks for calls and events from our contracts (the GajuPay watcher pattern).
- Record each projected change with its block height. Mark it *pending* at inclusion and *final* after two keyblocks.
- **Handle reorgs:** microblocks can be dropped. Projections must be reversible by height, or rebuilt from the last final height.
- Idempotent and resumable: store a cursor. Replaying from genesis must give the same read model.
- Emit metrics: indexer lag in keyblocks, reorg count, failed decodes.

## Testing

- Unit: GRIDS payload encoding round-trips, hash calculation, webhook signature checks.
- Integration against the local demo chain: submit tx → indexer projects pending → final.
- Reorg test: drop a microblock and check that the read model corrects itself.
- Replay test: rebuild the read model from scratch and compare.

## Checklist

- [ ] No user keys, no signing.
- [ ] Handlers idempotent. Webhooks verified.
- [ ] Pending vs final tracked. Reorgs handled.
- [ ] Read model can be rebuilt from chain plus evidence store.
