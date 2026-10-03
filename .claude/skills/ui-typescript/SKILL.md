---
name: ui-typescript
description: Frontend and TypeScript specialist for GajuFreight. Use for implementing apps/dashboard and the shared TypeScript packages (packages/grids, packages/chain-types) from the ux-designer journeys and wireframes, including GRIDS signing flows, accessibility in code, and component, unit and Playwright tests.
---

# UI / TypeScript specialist

You own `apps/dashboard` and the TypeScript in `packages/`. Read [docs/architecture-blueprint.md](../../../docs/architecture-blueprint.md) §2–4 first.

## Core model

- **The UI never signs.** Any action that moves value or changes status shows a **GRIDS QR code** (and a deep link on mobile) for GajuDesk/GajuMobile to sign. There's no private key, seed phrase or wallet extension anywhere in the app.
- **Chain is truth, API is a cache.** Show where data came from: *pending* (in a microblock, ~3 s) vs *final* (two keyblocks, ~3–4 min). Never show a payout as done until it's final.
- **Contract errors are part of the API.** Map `UPPER_SNAKE` error strings (`ONLY_SHIPPER`, `BAD_STATE`, …) to clear messages in one place.

## Screens

Build from the approved journeys and wireframes in `docs/ux/` and `docs/wireframes/`, owned by the `ux-designer` skill. Its wireframe rules and accessibility checklist are requirements here, not suggestions.

Style with Tailwind v4 on [`docs/brand/brand.css`](../../../docs/brand/brand.css): brand tokens and component classes only, no arbitrary colour values ([brand guide](../../../docs/brand/brand-guide.md)).

## TypeScript rules

- `strict: true`. No `any`. Validate API responses at the boundary (a schema validator) before using them.
- Amounts: keep them in the smallest denomination as `bigint`. Never `number`, never float. Format only for display.
- Mirror contract types in `packages/chain-types` (status union, checkpoint, event types). One source, imported everywhere.
- Status is a discriminated union. `switch` over it must be exhaustive (`never` check).
- Filenames are kebab-case (`shipment-timeline.tsx`). Components are `PascalCase` in code.
- Keep dependencies minimal and pinned. Every new package needs a reason in the PR and a GPL-3.0-compatible licence.

## Testing

- Unit tests for formatters (amounts, block height to date), the error-message map and status reducers.
- Component tests for each screen state, including pending, final and error.
- Playwright end-to-end tests against a local stack, with signing stubbed at the GRIDS boundary.

## Checklist

- [ ] No key handling or signing in the UI.
- [ ] Pending vs final shown correctly.
- [ ] Amounts are `bigint` end to end.
- [ ] Exhaustive status handling. New contract errors are mapped.
- [ ] Accessibility checked. Works at mobile width.
