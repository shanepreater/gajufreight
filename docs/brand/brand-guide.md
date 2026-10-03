# GajuFreight brand guide

| | |
| :--- | :--- |
| **Status** | Starter palette (2026-10-03). Colours may be tuned after the branded mock-ups are reviewed |
| **Owner** | `ux-designer` skill |
| **Sources** | [`brand.css`](brand.css) (tokens and components) · [Colour chart](colour-chart.html) · [Logo brief](logo-design-brief.md) |

GajuFreight is the freight product of the Gaju family: charcoal and white like the rest of the suite, with **Signal Orange** for freight. Every screen, from the dashboard to the field app, uses one set of tokens and components so that money and custody moments look the same everywhere.

## 1. Principles

- **Trust over decoration.** Money and custody are on the line, so state, amounts and who acts next come first.
- **Plain and industrial.** Strong contrast, square-ish shapes and few colours. It has to read on a phone on the quay in bright sun.
- **Colour reinforces and never carries meaning alone.** Every status also has a glyph and a word (○ pending, ● final, ⚠ warning, ✕ error).

## 2. Logo

All variants are in [`logo/`](logo/). The wordmark is Montserrat, outlined: "Gaju" is set in medium (500) and "Freight" in bold (700) Signal Orange.

| Variant | Use |
| :--- | :--- |
| [`logo-horizontal.svg`](logo/logo-horizontal.svg) / [`-dark`](logo/logo-horizontal-dark.svg) | App headers, documents, the default lockup |
| [`logo-stacked.svg`](logo/logo-stacked.svg) / [`-dark`](logo/logo-stacked-dark.svg) | Splash and sign-in screens, square spaces |
| [`logo-mark.svg`](logo/logo-mark.svg) / [`logo-mark-dark.svg`](logo/logo-mark-dark.svg) | Where the name is already shown nearby |
| [`logo-mono-black.svg`](logo/logo-mono-black.svg) / [`logo-mono-white.svg`](logo/logo-mono-white.svg) | Printed package labels, stamps, single-colour print |
| [`favicon.svg`](logo/favicon.svg) | Browser tabs, app icons (simplified for 16 px) |

- **Clear space:** keep at least the height of the mark's crossbar clear on every side.
- **Minimum size:** the horizontal lockup is at least 24 px high on screen, and the mark is at least 20 px. Below that size, use the favicon.
- **On dark backgrounds,** use the `-dark` or mono-white variant. Never place the light logo on charcoal.
- **Don't** recolour, stretch, rotate, outline or add effects, and don't set the wordmark in a different font.
- **Logos are exempt from text contrast rules**, so "Freight" may be Signal Orange on white. Running text may not.

## 3. Colour

Every colour is a token in [`brand.css`](brand.css). Its Tailwind utilities are `bg-<token>`, `text-<token>` and `border-<token>`, and these are the only colours that exist. Tailwind's default palette is switched off. Don't use arbitrary values such as `bg-[#…]`.

Tokens are semantic, so one class works in both themes. The dark theme follows the system setting, and `data-theme="light"` or `"dark"` on any element forces it. Never write `dark:` pairs.

| Token | Light | Dark | Use |
| :--- | :--- | :--- | :--- |
| `surface` | `#FFFFFF` | `#111827` | Page and card background |
| `surface-alt` | `#F3F4F6` | `#1F2937` | Filled panels, table stripes |
| `ink` | `#111827` | `#F9FAFB` | Body text, borders of controls |
| `muted` | `#4B5563` | `#D1D5DB` | Secondary text, hints |
| `line` | `#D1D5DB` | `#374151` | Decorative dividers only |
| `line-strong` | `#6B7280` | `#9CA3AF` | Input and control borders |
| `accent` | `#FF5722` | `#FF5722` | Brand orange: fills, marks, active step |
| `on-accent` | `#111827` | `#111827` | Text on orange |
| `accent-text` | `#C2410C` | `#FF8A65` | Links and orange text |
| `accent-surface` | `#FFF1EB` | `#431407` | Signing panels, active step |
| `info` | `#0057D9` | `#60A5FA` | Pending, chain links, focus ring |
| `info-surface` | `#EAF2FF` | `#172554` | Pending badge |
| `success` | `#15803D` | `#4ADE80` | Final, delivered |
| `success-surface` | `#ECFDF3` | `#052E16` | Final badge |
| `warning` | `#A16207` | `#FBBF24` | Needs attention |
| `warning-surface` | `#FEF7E6` | `#422006` | Warning badge |
| `danger` | `#B91C1C` | `#F87171` | Errors, irreversible |
| `danger-surface` | `#FEF2F2` | `#450A0A` | Irreversible panel, error badge |

**Rules:**

- **Signal Orange (`accent`) is never text on a light background,** where it reaches only 3.2:1. Use it for fills, marks, the active step and the primary button. For orange text and links, use `accent-text`.
- **The primary button is orange with a charcoal label** (`on-accent`). A white label fails AA on orange.
- **`line` is decorative.** It is never the only edge of a control; controls use `line-strong`.
- **Avoid `accent` marks on `surface-alt` in light mode** (2.9:1).
- **Danger red marks errors and irreversible actions only.** It is never used as a second brand colour.
- **Printed labels are always black on white,** whatever the screen theme.

### Approved pairs (WCAG 2.2 AA)

Text needs 4.5:1. Borders, focus rings and marks need 3:1. The [colour chart](colour-chart.html) recomputes these ratios from the stylesheet, and `npm run check --prefix scripts/wireframes` fails if this table, the chart or `brand.css` disagree.

| Text or mark | On | Use | Needs | Light | Dark |
| :--- | :--- | :--- | :-: | :-: | :-: |
| `ink` | `surface` | Body text | 4.5:1 | 17.74:1 | 16.98:1 |
| `ink` | `surface-alt` | Text on filled panels | 4.5:1 | 16.12:1 | 14.05:1 |
| `muted` | `surface` | Secondary text | 4.5:1 | 7.56:1 | 12.04:1 |
| `muted` | `surface-alt` | Secondary text on panels | 4.5:1 | 6.87:1 | 9.96:1 |
| `line-strong` | `surface` | Control borders | 3:1 | 4.83:1 | 6.99:1 |
| `accent` | `surface` | Marks, active step border | 3:1 | 3.16:1 | 5.61:1 |
| `on-accent` | `accent` | Primary button label | 4.5:1 | 5.61:1 | 5.61:1 |
| `accent-text` | `surface` | Links, orange text | 4.5:1 | 5.18:1 | 7.67:1 |
| `accent-text` | `accent-surface` | Money badge | 4.5:1 | 4.69:1 | 6.76:1 |
| `ink` | `accent-surface` | Text in the signing panel | 4.5:1 | 16.08:1 | 14.98:1 |
| `info` | `surface` | Focus ring, chain links | 4.5:1 | 6.24:1 | 6.98:1 |
| `info` | `info-surface` | Pending badge | 4.5:1 | 5.54:1 | 5.78:1 |
| `success` | `success-surface` | Final badge | 4.5:1 | 4.76:1 | 8.55:1 |
| `warning` | `warning-surface` | Warning badge | 4.5:1 | 4.61:1 | 8.73:1 |
| `danger` | `surface` | Error text | 4.5:1 | 6.47:1 | 6.41:1 |
| `danger` | `danger-surface` | Error badge | 4.5:1 | 5.91:1 | 5.84:1 |
| `ink` | `danger-surface` | Irreversible panel | 4.5:1 | 16.22:1 | 15.45:1 |

## 4. Typography

- **Montserrat** is self-hosted in [`fonts/`](fonts/) under the OFL. It has one variable file covering Latin, with a fallback to the system sans. 木 and other CJK glyphs come from the system font.
- **The scale is fixed:**

  | Size | Tailwind class | Use |
  | :--- | :--- | :--- |
  | 32 px | `text-2xl` | Shipment reference on its detail page |
  | 24 px | `text-xl` | `h1` |
  | 20 px | `text-lg` | `h2` |
  | 16 px | `text-base` | Body |
  | 14 px | `text-sm` | Tables, hints |
  | 12 px | `text-xs` | Badges only |

  Nothing goes below 12 px.
- **Weights:**
  - 400 for body text;
  - 600 for labels and buttons;
  - 700 for headings;
  - 800 for counters and QR kind labels.
- **Numbers line up:**
  - `.amount` and tables use tabular figures.
  - Amounts always carry 木.
  - Deadlines show a date *and* a block height.
- **Addresses and payloads** use `.mono` and are shortened (`ak_9Op…1Az`) with a way to copy the full value.

## 5. Shape, space and targets

- **Radius:** `--radius-sm` (4 px) for badges, `--radius-md` (6 px) for controls and cards, `--radius-pill` for chips and steps.
- **Spacing:** Tailwind's 4 px scale. Gaps between siblings are 0.5, 0.75 or 1 rem.
- **Targets:** every control is at least 44 px (`--spacing-target`). For radios and checkboxes, the whole `.choice` label is the target.
- **Focus:** a 3 px `info` ring with a 2 px offset on every focusable element. Never remove it.

## 6. Components

The components are defined in `brand.css` (`@layer components`), and the dashboard reuses the same class names.

| Class | Meaning |
| :--- | :--- |
| `.btn`, `.btn.primary`, `.btn.danger`, `.btn.block` | Actions. There is one primary action per view, and `danger` (a double red border) is for disputes and destructive actions |
| `.badge` + `pending` / `final` / `ok` / `warn` / `error` / `money` / `custody` | Status, always shown with a glyph and a word |
| `.steps` | Progress through a flow. The current step is orange |
| `.irreversible` | Required before any action that can't be undone, with the exact amount and recipient |
| `.grids-qr` | **Authorises** an action: a double orange frame, "Sign with your wallet" |
| `.label-qr` | **Identifies** a package: a dashed charcoal frame, "Package label". It must never look like `.grids-qr` |
| `.timeline`, `.meter`, `.card`, `.choice`, `.scan-list`, `.viewfinder`, `.counter` | Shipment history, quorum and countdowns, grouping, choices, field scanning |

**Money and custody states:** show *pending* (○, info blue) until finality, then *final* (●, green). Money is never shown as paid before *final*.

## 7. Voice

- **Plain words, and the action as a verb:** "Create and fund", "Confirm delivery", "Raise a dispute".
- **Say what happens next and who acts:** "Waiting for Brabant Road Haulage to scan in".
- **Wrong-stage errors** always read "That isn't possible at this stage of the shipment." The other contract errors use the messages in [`errors.js`](../../scripts/demo/lib/errors.js).
- **Irreversible actions say so:** "This releases 1,200 木 to the carrier. This can't be undone."
- **No blame, and no chain jargon** in the UI unless it helps the user act (for example a block height next to a deadline).

## 8. Using it

- **Tailwind v4:**
  - `@import 'tailwindcss';` then `@import '<path>/docs/brand/brand.css';`
  - `@source` your templates.
- **Build the wireframes and the chart:** `npm run build:css --prefix scripts/wireframes`. The built CSS is committed so the pages open without a build.
- **Browsers:** current evergreen browsers, since the stylesheet needs cascade layers.
