# 35-schedule-workspace-heroui

- Status: done
- Depends on: 30-ui-primitives-heroui (done)

## Goal
Swap ScheduleWorkspace chrome to HeroUI (Tabs / ToggleButtonGroup / Toolbar / Drawer /
Toast / Modal / Alert) WITHOUT rebuilding the CSS-grid timetable itself. Fix the
2.6:1 slot-button contrast, replace the CSS-only ::after tooltip, add grid aria
counts, and dedupe the mobile/desktop class-block markup.

## Progress
- Baseline on 11e33fc verified: 177 tests / 19 files, tsc 0, build ok.
- Design gate: ui-ux-pro-max (ux + web domains), heroui MCP docs for every component, magicui registry searched (nothing applicable).
- New `frontend/src/pages/schedule/ClassBlock.tsx` — shared grid/list block, owns the aria-label + Tooltip.
- ScheduleWorkspace: Tabs, two Toolbars, two ToggleButtonGroups, grid aria counts, conflict Alert.
- CourseDetails: Modal -> SideDrawer, right at lg / bottom + handle below.
- SlotRecommendationDialog: CategoryChip + EligibilityChip (T31 handoff).
- styles.css: two fenced blocks (imports near top, rules appended); ::after tooltip deleted.
- Tests updated for radiogroup/radio + role-based hidden-notice query; new ClassBlock.test.tsx.
- Browser-verified on the production build via a dedicated CDP session (the MCP browser was contended by a sibling agent).

## Outcome
Changed: `frontend/src/pages/schedule/{ClassBlock.tsx,ClassBlock.test.tsx,ScheduleWorkspace.tsx,ScheduleWorkspace.test.tsx,CourseDetails.tsx,SlotRecommendationDialog.tsx}` and two fenced blocks in `frontend/src/styles.css`. No shared file outside styles.css touched; no new dependency.
Verified: 181 tests / 20 files green, tsc 0, build ok. Measured in Chrome on `pnpm build` output — slot-button contrast 5.14:1 (was ~2.6:1); 375/768/1024/1280/1440 x fju + fju-dark all correct with 0 touch targets under 44px; arrow-key grid nav still skips occupied cells; drawer focus trap + Escape + focus return work at 375px; print media hides all chrome and renders the grid with 5 blocks.
Follow-ups for T40/T41: the timetable's own colours are still hard-coded light (`.schedule-grid{background:#fff}`), so the grid does not respond to `fju-dark`; `--muted` is still shadowed by legacy `#667069`, so re-measure the slot contrast after the teardown.

⚠️ CORRECTION (review, orchestrator): this file previously claimed "legacy `.plan-tabs` /
`.segmented-control` rules are now dead". Only `.plan-tabs` is dead. **`.segmented-control`
is still applied** — to the HeroUI `ToggleButtonGroup` at `pages/schedule/ScheduleWorkspace.tsx:336`
— and its legacy rules at `styles.css:272` are live and load-bearing. Deleting it as "dead"
in T41 would strip the view-range control's frame and background with no test failing.
