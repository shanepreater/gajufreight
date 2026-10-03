# ADR 0008: App sign-in sessions for a shift

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-03) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Architecture blueprint §4](../architecture-blueprint.md#4-trust-boundaries) · [ADR 0009](0009-organisations-and-directory.md) · [Round 4 review, item 8](../ux/review-round-4-feedback.md#8-quick-sign-in-and-sign-out) |

## Context

Today a user signs in by signing a one-time message with GajuDesk or GajuMobile, every time. Port handlers scan all day on shared, gloved, hurried phones, so a wallet round trip each time they open the app costs them real time. The wallet must stay the only signer of value and custody actions (hard rule 1).

## Decision

- **One wallet signature starts a session for the shift.** A signed, single-use challenge (with a nonce and expiry) starts a session bound to the device. It lasts up to **12 hours**, and the organisation can set it shorter.
- **The device unlock reopens it.** The session is protected by a WebAuthn platform authenticator (the phone's own screen lock or biometrics), with a **PIN** as the fallback. Reopening the app needs only that, not the wallet.
- **Sign-out takes one tap.** **Switch handler** ends the current session and starts the next handler's on the same device, without re-registering the device.
- **The session only identifies the caller.** It lets them read and prepare actions. Every custody or value action is still a GRIDS payload that the handler signs in their wallet (hard rule 1). Batching those is [HLD §7 Q10](../hld.md#7-open-questions).
- **The server is in control:** sessions are server-side, so they can be revoked. The owner of an organisation can revoke a member's session ([ADR 0009](0009-organisations-and-directory.md)). Sessions expire at the end of the shift, and after 30 minutes idle on shared devices.

## Consequences

- **Good:** one wallet signature per shift, then an unlock of about a second.
- **Cost:**
  - The API needs a session store, WebAuthn registration and PIN handling (hashed, with lockout).
  - A lost phone is covered by expiry, revocation and the device lock.
- **Risk:** WebAuthn on rugged, shared Android devices needs field testing. The PIN keeps it usable if a device can't use WebAuthn.
