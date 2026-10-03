# Journey: arbitrate a dispute (arbiter panel member)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 1) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [ADR 0002](../adr/0002-arbiter-panel.md) |

## Job

When a dispute lands with me, I want all the evidence and the other arbiters' positions in one place, so I can vote a fair split before the window closes.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Notified | Sees "Dispute GF-2026-0008 · 2 d 14 h left" | "How urgent is this?" | Interrupted | Deadlines buried in email | The countdown and the fallback split are shown upfront |
| Review | Reads the claim, timeline and evidence | "Is this evidence genuine?" | Analytical | Can't trust attachments | Every document shows **verified ✓ against the on-chain hash**; custody exceptions are highlighted |
| **Vote** 💰 | Chooses a split | "What would be fair?" | Deliberate | Being swayed by earlier votes | **Other votes stay hidden until you've voted** ([privacy standard](../hld.md#68-privacy-standard)); show the 木 amounts live as the split changes |
| Wait or settle | Sees everyone's votes, then "1 more matching vote needed", or *settled* | "Did it go through?" | Uncertain | Not knowing if it's final | After voting: each vote, quorum progress (e.g. 1 of 2) and pending → final |

## Flow

**Entry:** *Needs your action → Dispute GF-2026-0008*.

1. **Dispute view:** the claim, the timeline with exceptions, verified evidence, how many arbiters have voted (not how), quorum needed, and the fallback countdown and split.
2. **Vote:** 0–100% to the carrier, with live 木 amounts. Only after signing do the other votes appear, and the arbiter can change their vote until the dispute settles.
3. **Sign:** "If this makes 2 matching votes, 60% (1,800 木) goes to the carrier and 40% to the shipper. This can't be undone."

**Steps:** 2 screens and 1 signature (more if they change their vote).

**Exits:**
- **Settled by quorum:** the receipt.
- **Waiting:** "Waiting for 1 more matching vote." They can change their vote until the dispute settles.
- **Window passed:** any party or arbiter can **Apply the fallback split**, and the screen says who can and what it pays.
- **Not on this panel:** `ONLY_ARBITER` → read-only view.
