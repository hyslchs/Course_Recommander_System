# 31-course-card-heroui

- Status: done
- Depends on: 30-ui-primitives-heroui (done)

## Goal
CourseCard (shared by 3 pages, highest exposure) to HeroUI Card/Chip/Disclosure/RadioGroup. Fix .meta span 12.5px. Handle runtime-composed class names (R3).

## Progress
- Design gate: ui-ux-pro-max (ux + web domains); heroui-react MCP list_components + get_component_docs for Card/Chip/ToggleButton/Tooltip/Disclosure/RadioGroup/Alert/Button/Badge; magicuidesign-mcp searched, nothing applicable (all 17 hits are marketing effects), motion stays T40-only.
- Badge deliberately NOT used: its own docs say use Chip for standalone labels, and Badge needs Badge.Anchor positioning. The `#N` rank stays a plain span.
- Components adopted: Card (+Header/Title/Description/Content/Footer), Chip, ToggleButton, Tooltip, Disclosure, RadioGroup+Radio, Alert, Button isPending. Seven per-component CSS imports added to styles.css inside one commented T31 block.
- R3 solved with data attributes rather than @source inline: `data-eligibility` / `data-category`, matched by literal attribute selectors. 19 new tests pin icon + wording + HeroUI colour class for all four statuses (both label sets) and all four categories.
- T02 handoff honoured: both label sets stay separate; `EligibilityChip` takes `labels="long"|"short"` so T35 can reuse the triple channel without duplicating it. Exported from components/CourseCard/index.ts.
- courseVariants.css deleted; its `.variant-list button` rules replaced by radio rules in the T31 styles block. Required removing one import line from src/main.tsx (outside the fence, unavoidable).
- Measured in Chrome at 375/768/1024/1440 x fju/fju-dark: no horizontal scroll, 1 col at 375 and 2 cols from 768, actions 44px tall with 8px gaps (was 7.2px), heart 44x44, zero sub-15px text left in the card.
- Two extra 4.4 fixes found by measuring: HeroUI `.chip` is 14px (12.16px under the legacy official-tags rule) -> 15px; `.tooltip` is `text-xs break-all` -> 15px + break-word.
- Dark mode: bound `.course-card` background/color to `--surface`/`--surface-foreground`. The legacy light-only `background:#fff` left the status chips at 2.56:1 under fju-dark. Light is unchanged (title 17.76:1).

## Outcome
Done. 164 tests / 18 files (was 145/17), tsc 0 errors, build green. CSS 615.68 -> 646.51 kB (gzip +2.69 kB), JS +1.50 kB (gzip +0.42 kB). CourseCard props unchanged.

Known, not fixed here (T41): `--muted` is still shadowed by the legacy `#667069`, so the English course name is 5.14:1 in light (AA ok) but 3.39:1 under fju-dark. `--danger` and `--focus` are likewise shadowed, so the favourite-active colour and the focus ring stay legacy literals.
