# Review — wave 3 (T33 recommend / T34 explore / T35 schedule / T36 data+assistant)

Reviewed at `f15db5f` (four page migrations + four merges + the de-flake commit).
Three independent reviewers, run concurrently: Codex over the diff, a plan-adherence
reviewer, and a browser/a11y reviewer with exclusive chrome-devtools access.

## Test / build status

| Check | Result |
|---|---|
| Frontend tests | 232 / 26 files — 22 consecutive clean full runs |
| Backend tests | 39 / 39 (`/tmp/fjuvenv/bin/pytest`) |
| `tsc -b --force` | 0 errors |
| `pnpm build` | ok — CSS 787.07 kB / 251.29 kB gz, JS entry 466.60 kB / 145.80 kB gz, 10 route chunks |
| Console / network | zero JS errors, zero warnings, zero failed requests across all six routes |

Three flakes were fixed before review (commit `f15db5f`): a mock keeping one
resolver for a query that fires more than once, a pagination wait condition that
was also true mid-load, and the 1000ms testing-library default being too tight at
26 files. Found by looping the suite and capturing logs, not by rerunning to green.

## Confirmed correct (checked, not merely claimed)

- **T35's hard boundary held.** `.schedule-grid`, `.class-block` row-spanning,
  `role="grid"/columnheader/rowheader/gridcell`, roving tabindex + `onSlotKeyDown`
  2-D navigation with occupied-cell skipping, `@media print`, conflict hatch — all
  intact, none quietly reimplemented.
- **T34's 300ms debounce is byte-identical to baseline.** ComboBox reuses
  `filterDepartmentOptions` rather than reimplementing it.
- **T36's `importBackup` fires exactly one event** on the success path.
- **T30 handoff #2 passes cleanly** — every HeroUI component used has its
  stylesheet; T34's unconventional trailing `@import` is honoured in the built CSS.
- **R9 holds** — exactly one `<h1>` on each of six routes.
- **R3 improved** — T35 removed two runtime-composed union class names; one
  pre-existing survivor (`slot-category-filter ${category}`) is safe today.
- Keyboard: drawer/modal focus trap, Escape, return-focus, ComboBox, plan tablist,
  grid 2-D navigation, focus-on-error — all pass with real key events.

## Refuted — do not carry forward

- **The toast is NOT Simplified Chinese.** Captured live as `aria-label="1 個通知。"`
  (traditional 個, U+500B). T32's `zh-Hant-TW` → `zh-TW` change fixed it. The T30
  finding recorded in T42 no longer reproduces — **T42's 🔴 item is already done.**
- **R10's print hide-list is already implemented**, ahead of T41.
- **T32's focus-on-error gap is closed.**
- **`prefers-reduced-motion` is comprehensively covered**, including the global
  smooth-scroll neutraliser.

## Defects found → fix tasks

| # | Defect | Severity | Fix task |
|---|---|---|---|
| 1 | `importBackup` in-batch duplicate IDs silently drop records | **data loss** | `52` |
| 2 | `importBackup` per-store commit can partially apply and notify nobody | **data loss** | `52` |
| 3 | `/schedule` 117px page h-scroll @375 — `scroll-shadow.css` never imported (transitive dep of `Tabs`) | P1 | `51` |
| 4 | `/schedule` 7-day picker overflows 51px @375 (plan assumed 5 days; weekend classes are real) | P1 | `51` |
| 5 | `role="grid"` has no `role="row"` children → Lighthouse 90 vs 100 elsewhere | P1 a11y regression | `51` |
| 6 | DataPage `Modal` buttons unstyled — T36 converted raw `<button>`→HeroUI `<Button>` inside an uncovered portal | P1 regression | `50` |
| 7 | `Tag.RemoveButton` renders as a 44×44 white box on `/recommend` | P1 regression | `50` |
| 8 | Empty-slot affordance invisible at rest (`span{opacity:0}` not overridden) | P2 | `51` |
| 9 | `.class-block small` 11.33px @ 4.25:1 | P2 | `51` |
| 10 | Print clips the timetable (1122px into 778px) — silent data loss on paper | P2 | `51` |
| 11 | Explore sort state + keyboard focus lost when the `lg` breakpoint flips | P2 | `53` |
| 12 | `CourseDetails` first render always mobile → bottom-sheet flash on every desktop open | P2 | fixed in `1aa620a` |
| 13 | Five duplicated `revert-layer` repairs; three portal strategies; 44px floor written 3 ways | systemic | `50` |
| 14 | Filter drawer commits on every dismissal despite an explicit 套用 button | UX | `54` (user chose discard) |
| 15 | Desktop table had no actions | scope | `53` (user chose action column) |

Corrected in the plan: T35's report claimed `.segmented-control` was dead. It is
**live and load-bearing** — deleting it in T41 would strip the view-range control's
frame with no test failing. A verified dead-CSS list is now recorded in T41.

## Verdict against the plan's success criteria

- **Accessibility must not regress** — *not met before the fix wave*, on one route:
  `/schedule` desktop scores Lighthouse 90 (missing grid rows) against 100
  everywhere else, plus the invisible slot affordance. Fix task `51` targets exactly
  this. Everything else improved.
- **Mobile-first at four widths** — met on 5 of 6 routes; `/schedule` fails at 375.
- **§4.2 contrast** — met in light (0 non-exempt failures across 306 sampled
  elements on 4 of 5 routes; the predicted 17.76:1 and 6.39:1 pairings verify
  exactly), **failed in dark: 48 failures, floor 1.09:1**. See below.

## Dark mode: broken app-wide, and it changes the plan order

All four implementing agents independently reported this; the browser reviewer
quantified it. Share of page pixels still light under `fju-dark`:
`/schedule` **94.5%**, `/onboarding` 65.9%, `/recommend` 68.1%, `/data` 49.8%,
`/explore` 34.3%. Every cause is legacy CSS that T41 is chartered to delete:
unlayered `html{background:#f3f5f1}`, a white `header.topbar` on every route,
`--surface-secondary`/`--surface-tertiary` undefined for `fju-dark`, hard-coded
light timetable hex, and the shadowed `--muted` (31 of 48 failures on its own).

**Recommendation: split T41 and run T41a before T40.** T40's acceptance gate is
"five pages × light/dark"; that gate is not meaningful while the legacy sheet wins,
and T40 cannot fix these without duplicating T41. The plan already contains the
circularity — T41 says to re-measure contrast after the teardown, while T40's
acceptance needs the tokens that teardown unshadows. Recorded in `tasks.md`.
