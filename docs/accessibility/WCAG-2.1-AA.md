# WCAG 2.1 AA audit of the portal (M6-02)

> Versión en español: [docs/es/accessibility/WCAG-2.1-AA.md](../es/accessibility/WCAG-2.1-AA.md)

- Date: 2026-11-16. Scope: the 42 screens of `apps/web` in Spanish and English, the dialogs that appear over them, and the Keycloak pages that are part of the flow (sign-in and registration).
- Method: an automated review of every screen, repeated on every e2e run, plus a manual review, criterion by criterion, of what the automation cannot judge.
- Statuses: **Meets** · **Fixed** (in this story) · **Not applicable** · **Pending** (with a target).

## Automated review

`apps/web/e2e/accessibility.spec.ts` visits every screen with the role that sees the most of it, in Spanish and in English. First it publishes an API with sensitive data and leaves it in the state where every screen of the approval chain exists: approved by the operator and the regulator, with an access request approved by the data steward and waiting for the regulator. A test fails if a page is added that is not in the walkthrough.

On every screen:

| Check | Criterion |
| :-- | :-- |
| axe, WCAG 2.0/2.1 A and AA rules | Several (contrast, names, roles, labels, structure) |
| Document `lang` matches the language of the route | 3.1.1 |
| Its own title (only the home page carries the bare product name) | 2.4.2 |
| A single level-1 heading, counting `aria-level` | 1.3.1, 2.4.6 |
| The first Tab reaches the "Skip to content" link | 2.4.1 |
| The following interactive elements show a visible focus | 2.4.7 |
| No visible text outside the container that clips it, with the criterion's text spacing | 1.4.12 |
| No horizontal scrolling at 320 px (a table may scroll inside its own container) | 1.4.10 |

Also:
- The session timeout warning: it appears on time, takes focus, passes axe and keeps the session alive.
- The Keycloak sign-in and registration pages, with axe only: they are Keycloak's theme, not ours.

To audit without failing on the first finding: `DEN_A11Y_REPORT=1 pnpm --filter @den/web exec playwright test e2e/accessibility.spec.ts`.

## Findings and fixes

| # | Finding | Criterion | Fix |
| :-- | :-- | :-- | :-- |
| 1 | API validation errors reached Spanish pages in English ("at most 6 months for this classification", zod messages, the `detail` of 409 and 403) | 3.1.2, 3.3.1, 3.3.3 | Every API error carries `key` and `params`, and the web shows them in the user's language. zod errors are written with zod's locale. ADR-0025 |
| 2 | The session ended after 30 minutes of inactivity without warning, and whatever had been typed was lost | 2.2.1 | A dialog two minutes before, with "Stay signed in", which renews the session with Keycloak (`components/session-timeout.tsx`, `DEN_SESSION_IDLE_SECONDS`); before warning, and before declaring the session over, it asks the server how long it really has left (`/api/session/keepalive`, B-25) |
| 3 | With more than one entity, the header selector overflowed at 320 px | 1.4.10 | The selector wraps onto several lines |
| 4 | The tables on the service page overflowed the page at 320 px | 1.4.10 | Scrolling inside their own container, like the other tables |
| 5 | The Scalar documentation added a second `h1` to the API page | 1.3.1 | Its headings move down one level (`aria-level`) |
| 6 | The tooltip of the usage charts and of the exchange map did not close with Escape | 1.4.13 | Escape hides it without moving the pointer or the focus |
| 7 | The status of an access request changed silently while the page refreshes itself | 4.1.3 | The status is a `role="status"` region |
| 8 | The limit on open onboarding requests returned a generic 409 | 3.3.1 | The conflict states the reason and the maximum (`too_many_open_requests`) |
| 9 | At 320 px these also overflowed:<br>• the usage and indicator tables, because the grid grew with the table;<br>• the access request form, because a `fieldset` takes the width of its content and long paths did not wrap;<br>• the exchange map and the daily chart, because of their minimum width | 1.4.10 | `minmax(0, 1fr)` columns, a `fieldset` that shrinks (global rule), paths that break where needed, charts from 240 px |
| 10 | With the criterion's text spacing, the SVG clipped the axis labels of the usage charts, and Scalar's "Download OpenAPI Document" link was cut off | 1.4.12 | The SVG shows what spills past the card's edge. The Scalar link wraps onto several lines (our own CSS on top of Scalar) |

## Status by criterion

| Criterion | Status | Notes |
| :-- | :-- | :-- |
| 1.1.1 Non-text Content | Meets | Decorative logo with `alt=""` inside a named link. Icons are `aria-hidden`. Charts have a name, each bar or link has its text, and there is a table with the same data |
| 1.2.x Time-based Media | Not applicable | There is no audio or video |
| 1.3.1 Info and Relationships | Fixed | Tables with `th scope`, definition lists, `fieldset`/`legend` for groups, associated labels. #5 |
| 1.3.2 Meaningful Sequence | Meets | DOM order is visual order |
| 1.3.3 Sensory Characteristics | Meets | Instructions do not rely on shape, color or position |
| 1.3.4 Orientation | Meets | No orientation lock |
| 1.3.5 Identify Input Purpose | Meets | The user's own data is collected in Keycloak (registration), with `autocomplete`. In the portal, the person fields are about third parties (designated people, data officer) and carry `autocomplete="off"` on purpose |
| 1.4.1 Use of Color | Meets | Statuses carry text as well as color |
| 1.4.2 Audio Control | Not applicable | |
| 1.4.3 Contrast (Minimum) | Meets | axe on every screen. Each country's brand color is darkened for text (`--primary-ink`), and Scalar has its own palette that meets 4.5:1 |
| 1.4.4 Resize Text | Meets | Relative units. Covered by reflow at 320 px (400 %) |
| 1.4.5 Images of Text | Meets | There are none |
| 1.4.10 Reflow | Fixed | #3, #4, #9. Wide tables scroll inside their container (the criterion's exception for tabular data) |
| 1.4.11 Non-text Contrast | Meets | Control border #8e8e8e: 3.28:1 on white, 3.08:1 on the surface. Focus ring #0f0f0f: 19:1 |
| 1.4.12 Text Spacing | Fixed | #10. Checked on every screen: no visible text ends up outside the container that clips it |
| 1.4.13 Content on Hover or Focus | Fixed | #6. The tooltip also appears on focus, can be hovered with the pointer and closes with Escape |
| 2.1.1 Keyboard | Meets | Everything uses native elements. The chart bars and the map links receive focus |
| 2.1.2 No Keyboard Trap | Meets | The session dialog is not modal. Scalar does not trap focus |
| 2.1.4 Character Key Shortcuts | Meets | There are none |
| 2.2.1 Timing Adjustable | Fixed | #2. The automatic refresh while a change is being applied lasts at most one minute and sets no time limit for the user |
| 2.2.2 Pause, Stop, Hide | Meets | No animations or carousels. The automatic refresh is short (≤ 60 s) and only during a transient state. `prefers-reduced-motion` is respected |
| 2.3.1 Three Flashes or Below Threshold | Meets | There are none |
| 2.4.1 Bypass Blocks | Meets | "Skip to main content" on every screen, checked |
| 2.4.2 Page Titled | Meets | Each screen has its own title, checked |
| 2.4.3 Focus Order | Meets | DOM order. The session dialog takes focus and gives it back |
| 2.4.4 Link Purpose (In Context) | Meets | axe. Links in tables carry the name of the resource |
| 2.4.5 Multiple Ways | Meets | Main navigation, a home page with shortcuts by role, search in the catalog |
| 2.4.6 Headings and Labels | Meets | Checked |
| 2.4.7 Focus Visible | Meets | A fixed dark ring for any brand color, checked |
| 2.5.1 Pointer Gestures | Meets | There are no gestures |
| 2.5.2 Pointer Cancellation | Meets | Native elements (they activate on release) |
| 2.5.3 Label in Name | Meets | The accessible name starts with the visible text (e.g. "Notificaciones" with its counter) |
| 2.5.4 Motion Actuation | Not applicable | |
| 3.1.1 Language of Page | Meets | Checked in es and en |
| 3.1.2 Language of Parts | Fixed | #1. The technical diagnostics of the OpenAPI lint stay in English on purpose, because they name rules and fields of the document (ADR-0025) |
| 3.2.1 On Focus | Meets | |
| 3.2.2 On Input | Meets | Changing the active entity has its own button; no `select` navigates by itself |
| 3.2.3 Consistent Navigation | Meets | The same header and footer on every screen |
| 3.2.4 Consistent Identification | Meets | The same components and text for the same functions |
| 3.3.1 Error Identification | Fixed | A summary with `role="alert"` and an error next to each field with `aria-describedby`. #1, #8 |
| 3.3.2 Labels or Instructions | Meets | A visible label on every field, "(Obligatorio)" in the text, hints with `aria-describedby` |
| 3.3.3 Error Suggestion | Fixed | Messages say what to correct, in the user's language (#1) |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Meets | Decisions with consequences (rejection, revocation, suspension, deletion under legal order) ask for a reason or a confirmation. An approval can be reversed by revocation. What is submitted can be reviewed first |
| 4.1.1 Parsing | Meets | HTML generated by React. Unique ids with `useId` |
| 4.1.2 Name, Role, Value | Meets | axe on every screen. Native elements, and ARIA only where there is no native element |
| 4.1.3 Status Messages | Fixed | Confirmations with `role="status"`, errors with `role="alert"`. #7 |

## Keycloak

The sign-in, registration and one-time code pages use the `keycloak.v2` theme (PatternFly), in Spanish and English depending on the realm. axe finds no violations on sign-in or registration (test "Keycloak's sign-in and registration pages"). A country-specific theme would be operator configuration and should pass the same test.

## What the automation does not cover

- **Screen readers.** This audit checks names, roles, states and live regions with axe and with tests, but it was not tested with NVDA, JAWS or VoiceOver. Before going to production, the operator must walk through the main flows with NVDA and Firefox and with VoiceOver and Safari: entity onboarding, publication, access request and approval, regulator review.
- **Users with disabilities.** A test with real users, ideally from the entities, would find comprehension problems that no tool sees. This remains a recommendation for operations.

## How to keep it up

- A new screen must be added to `SCREENS` in `e2e/accessibility.spec.ts`: the coverage test fails if it is missing.
- A new API business rule with a field error defines its `FieldErrorKey` and its texts (ADR-0025): `src/i18n/messages.test.ts` fails if they are missing.
