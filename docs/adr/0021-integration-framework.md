# ADR 0021: Integration framework for third parties

| | |
| :--- | :--- |
| **Status** | Accepted (2026-10-11, [decision log](../decision-log.md) #31); the code is placeholders until the first partner (X22, X23) |
| **Last reviewed** | 2026-10-12 |
| **Related** | [Forwarder gap analysis](../forwarder-gap-analysis.md) · [HLD §8](../hld.md#8-system-architecture) · [ADR 0013](0013-off-chain-data.md) · [ADR 0016](0016-hosting-and-environments.md) · [Threat model](../threat-model.md) T14, T36 |

## Context

Forwarders expect their platform to book space with carriers, show schedules and tracking, and handle customs filings. Building those systems is out of scope (decision log #30): established providers already do them, and several are regulated. GajuFreight should integrate with partners instead. The owner asked for the integration process to be defined now, with placeholders in the code, so a partner can be added later without redesign.

## Decision

1. **One port per capability.** The `gajufreight-integrations` package defines one `Protocol` per capability:
   - `SpaceBooking`: request and cancel space;
   - `Schedules`: departures between two places;
   - `Tracking`: container and vessel events;
   - `CustomsFiling`: submit a declaration and follow its status.
   Data crossing the boundary is a small set of immutable models that refuse unknown fields (`SpaceRequest`, `SpaceConfirmation`, `Departure`, `TrackingEvent`, `CustomsDeclaration`, `CustomsStatus`). Places are UN/LOCODEs, as on-chain.
2. **Adapters per provider.** A partner's adapter implements one or more ports and maps the partner's format onto these models. Services receive an `Integrations` set through dependency injection. Until a partner is configured, each capability is a `NotConfigured` placeholder that refuses its calls with `IntegrationNotConfiguredError`, so nothing silently pretends to work.
3. **Trust (hard rule 5).**
   - Everything inbound is untrusted: a `TrackingEvent` is always marked untrusted and may only prompt an attestor to sign.
   - A carrier's booking confirmation is an off-chain record. Integrations never move money or change on-chain state.
4. **Inbound:** partner webhooks follow threat model T14 (signature, timestamp window, dedupe on event id).
5. **Outbound:** domain events (shipment booked, confirmed, milestone paid, delivered) go to adapters through an outbox, so a slow or failing partner never blocks a user and retries independently. The same outbox serves forwarders' own systems (X20).
6. **Credentials.**
   - GajuFreight's own partner credentials live in SOPS and OpenBao (ADR 0016).
   - A forwarder's own carrier-account credentials are encrypted per organisation in the `app` schema, with keys wrapped by the key service (ADR 0013), and are used only for that organisation's shipments.
7. **Adding a provider** follows the same steps every time:
   1. write the adapter for the capability's port;
   2. add contract tests against recorded fixtures;
   3. run it in the partner's sandbox;
   4. add a threat-model row, a runbook and a feature flag;
   5. pass a security review;
   6. enable it per environment.
   The webhook route and the outbox are built with the first partner, not before.

## Consequences

- **Good:**
  - Partners slot in behind stable ports.
  - Changing provider touches only its adapter.
  - Services can be written and tested against the ports now.
  - No integration can move money or alter on-chain state.
- **Costs:** a small package to maintain before any partner exists. The models may need fields once a real partner's data is seen; that's expected and cheap while nothing depends on them.
- **Not decided here:**
  - which partners (X22 carrier booking, X23 customs, X5 tracking);
  - commercial terms with them;
  - whether forwarders bring their own carrier accounts or use GajuFreight's.
