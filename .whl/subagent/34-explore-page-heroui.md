# 34-explore-page-heroui

- Status: done
- Depends on: 30-ui-primitives-heroui (done)

## Goal
ExplorePage to HeroUI: SearchField (keep 300ms debounce), ComboBox for department,
Select for weekday, Pagination + Summary, and a breakpoint-switched layout —
Table with allowsSorting at lg+, cards below lg.

## Progress
- Reset worktree to 11e33fc; baseline verified: 177 tests / 19 files, tsc 0 errors.
- Design gate done: ui-ux-pro-max (ux/web/react), heroui-react MCP, magicuidesign MCP.
- context7 MCP quota exhausted at account level; APIs re-verified against node_modules/@heroui/react 3.2.4.
- Page rebuilt: SearchField / ComboBox / Select / Pagination + Summary / Table.
- Breakpoint switch is a JS media query (`useIsDesktop`), not duplicated DOM.
- Skeleton is plain markup carrying HeroUI BEM classes, not a React Aria grid.
- INCIDENT: `git stash` is shared across worktrees; my stash and T33's crossed.
  Recovered from dangling stash commits; tree verified clean against 11e33fc.
- Browser verification at 375/768/1024/1440, fju + fju-dark, via chrome-devtools MCP.
- Lighthouse accessibility 100 (desktop and mobile) after the header-contrast fix.
- 196 tests / 20 files green (4 consecutive runs), tsc 0 errors, build ok.

## Outcome
Changed: `frontend/src/pages/explore/{ExplorePage.tsx,CourseTable.tsx,useIsDesktop.ts,ExplorePage.test.tsx}`
and one fenced block appended to `frontend/src/styles.css`. No shared file touched.
Verified by 196 unit tests, `tsc -b`, `pnpm build`, and measured chrome-devtools runs at
four widths in both themes (no horizontal scroll, targets >=44px, keyboard-complete, a11y 100).
Follow-ups for T41: `--surface-secondary`/`--surface-tertiary` are undefined for `fju-dark`
(patched page-scoped in the fence, belongs in `theme/fju.css`); Inter is absent so `--font-sans`
resolves empty and Latin renders in Noto Sans TC, whose digits are already uniform-width;
`/api/v1/courses` has no sort direction, so table sorting is page-scoped and says so.
