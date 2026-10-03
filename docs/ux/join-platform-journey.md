# Journey: join GajuFreight (company owner)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 5) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes: join](../wireframes/join.html) · [Your company](../wireframes/organisation.html) · [Verification queue](../wireframes/admin-settings.html#verify) · [ADR 0009](../adr/0009-organisations-and-directory.md) |

## Jobs

- **Company owner** (forwarder, carrier, final-mile, attestor or arbiter): When I want work through GajuFreight, I want to get my company listed and my team set up quickly, so shippers can find, invite and pay us.
- **Admin:** When a company signs up, I want to check it's real and licensed, so the directory can be trusted.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Sign up | Chooses what the company does, signs with the owner's wallet | "Is this worth the effort?" | Doubtful | Long onboarding forms | Five short steps. Work by direct invitation starts at once |
| Profile | Lanes, modes, certifications, contacts | "Who sees this?" | Careful | Over-sharing | Each field says who sees it |
| Documents | Uploads registration, insurance, licence | "Is my data safe?" | Wary | Documents leaking | Seen only by the owner and admins, never on-chain |
| Team | Shares an invite link | "Do drivers need my key?" | Relieved | Shared logins | Each member joins with their own wallet and role |
| **Verified** | Is listed in the directory | "Will shippers find us?" | Pleased | Waiting without news | The queue shows waiting time; target 2 working days |

## Flow

**Entry:** *Join GajuFreight*, or an invitation from a shipper or forwarder.

1. **Company:** choose its kinds. 2. **Wallet:** sign as owner. 3. **Profile.** 4. **Documents.** 5. **Team:** invite link → *Submit for verification*.
6. **Admin:** verify, ask for more, or reject with a reason.

**Steps:** 5 sections and 1 signature. The admin reviews 1 screen.

**Exits and edge cases:**
- **Unverified:** can quote when invited directly, and is marked *Unverified*.
- **Rejected:** the reason is shown, and the company can resubmit.
- **Member leaves:** the owner removes them, which signs them out at once.
- **Handler joins after a booking:** can't attest on it. A listed colleague can, or the shipper can add them (ADR 0006, proposed).
- **Insurance expires:** the company is asked to re-verify.
