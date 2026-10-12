# gajufreight-integrations

The ports through which GajuFreight talks to third parties: booking space with carriers, sailing schedules, tracking feeds and customs filing ([ADR 0021](../../docs/adr/0021-integration-framework.md)). Each capability is a `Protocol`; a partner's adapter implements it. Until a partner is chosen, every capability is a `NotConfigured` placeholder that refuses the call.

| Module | What it holds |
| :--- | :--- |
| `models` | What crosses the boundary: space requests and confirmations, departures, tracking events (always untrusted), customs declarations |
| `capabilities` | One `Protocol` per capability: `SpaceBooking`, `Schedules`, `Tracking`, `CustomsFiling` |
| `placeholders` | `NotConfigured` stubs and the `Integrations` set a service is given |

Nothing here moves money or changes on-chain state: inbound data only prompts a person to act (hard rule 5).

```sh
uv run pytest packages/integrations
```
