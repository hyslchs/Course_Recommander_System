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

---

# Re-review after the fix wave — `2b163c8`

All 15 defects fixed across six commits (FIX50–FIX54 plus two orchestrator fixes).
Independently re-verified in a real browser against the live backend.

| Check | Result |
|---|---|
| Frontend tests | **253 / 26 files** — clean across 8 + 3 consecutive runs |
| Backend tests | 39 / 39 |
| `tsc -b --force` | 0 errors |
| `pnpm build` | ok — CSS 792.62 kB / 251.85 kB gz |

**All 11 verification items PASS**, measured: `/schedule` page h-scroll 0px across
48 width×theme×route combinations · day picker 7 buttons at 46.7×44 in one row,
right edge 351 in a 375 viewport · **Lighthouse a11y 100 desktop AND mobile** with
`aria-required-children`/`aria-required-parent`/`label-content-name-mismatch` all
clean · slot affordance visible at 13px / **5.139:1** · `.class-block small` 13px /
**6.736:1** · `/data` dialog buttons distinct with accent fill 8.398:1 light,
9.211:1 dark · drawer discard proven on all five paths with no draft leak · explore
action column writes to IndexedDB, not sortable, absent below `lg` · sort and focus
survive the breakpoint · pagination fix **negative-controlled against a rebuilt
baseline bundle** (baseline snapped back to page 1 at +420ms; fixed stays).

**FIX50's consolidation is clean** — a systematic A/B of 492 control measurements
(6 routes × 2 themes, new CSS vs baseline CSS over the same DOM) found **zero**
HeroUI controls rendering as the legacy white box, and legacy non-HeroUI buttons
byte-identical. It also covers FIX53's newly added buttons, which would otherwise
have been legacy white boxes.

## Adjudicated: the original "white box" finding was partly wrong

The plan-adherence reviewer reported `/recommend`'s `Tag.RemoveButton` as a white
box that stayed white in dark mode. Re-measured against a rebuilt `1aa620a` bundle
(byte-size match): baseline was **rgb(243,242,240) light / rgb(36,39,45) dark** —
HeroUI's own `bg-default`, which *did* flip with the theme and was identical to the
chip background, so it was never visible as a box at all. Only the oversized 44×44
footprint was real. The white-box description belongs to the *other* portalled
controls (DataPage modal buttons, drawer close), where it reproduced exactly. The
fixing agent's challenge to its own brief was correct.

## One regression introduced by the fix wave, and fixed

FIX51's `.mobile-day-picker` rule was unscoped and had the same (0,2,0) specificity
as the `min-width:768px` `display:none` while coming later in source order, so the
picker rendered above the full 7-day grid at every desktop width. Scoped to
`max-width:767.98px` in `2b163c8`; verified `display:none` at 1440 with the grid
intact, and mobile unchanged.

## Corrections to this report's own earlier claims

- **`/data` Lighthouse a11y is 95, not 100** — `aria-allowed-attr` on the storage
  `Meter` (`role="meter progressbar"`; axe cannot resolve the multi-token role).
  **Reproduced identically at 95 on the pre-wave baseline**, so it is not a
  regression — but "100 everywhere else" above was wrong. Real AT resolves `meter`,
  which permits those attributes, so user impact is likely nil.
- FIX51 self-reported 1 residual mobile `label-content-name-mismatch` item. It does
  not reproduce; the audit is clean on both desktop and mobile.

## Verdict

- **Accessibility must not regress — MET.** `/schedule` 90 → **100 desktop and
  mobile**; `/recommend`, `/explore`, `/onboarding`, 404 all 100; `/data` 95
  unchanged from baseline. No route regressed.
- **Mobile-first at four widths — MET.** 0px page h-scroll across all 48
  combinations; 0 sub-44px focusable targets at 375 on all five app routes.
- **§4.2 contrast in light — MET.** 565 text elements sampled across 6 routes,
  **0 failures**.
- **Dark mode — still broken**, unchanged and pending the legacy teardown: 83
  failures / 553 sampled, floor 1.09:1, `html` still rgb(243,245,241) under
  `fju-dark`. (Not comparable to the earlier count of 48 — different page states.)

## Known, pre-existing, not caused by this wave

`--focus` resolves to the legacy green `#0d5238` rather than the plan's accent
(same shadowing family as `--muted`; add to T41's list) · `/explore` SearchField
clear button reads "Close" in English on a zh-Hant page · 開啟官方課綱 links are
96×24 at 375 (passes WCAG 2.5.8 AA, under §5.3's 44px preference) · the `<lg` card
layout does not reflect the table sort — **worth a product decision**.
