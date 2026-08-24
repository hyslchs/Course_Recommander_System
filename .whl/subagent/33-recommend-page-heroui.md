# 33-recommend-page-heroui

- Status: done
- Depends on: 30-ui-primitives-heroui (done)

## Goal
RecommendPage to HeroUI: kill `.hero`, query box to Card+TextArea, filter groups to
Accordion/Disclosure, applied-filter pills to TagGroup, and the lg-breakpoint split
(320px sidebar vs bottom Drawer). Biggest mobile win of the wave.

## Progress
- Reset worktree to 11e33fc; baseline verified 177 tests / 19 files, tsc 0 errors.
- Design gate: ui-ux-pro-max (ux/web/react domains), heroui-react MCP docs for every adopted component, magicuidesign-mcp searched (nothing applicable).
- Verified HeroUI 3.2.4 compound APIs against node_modules d.ts (MCP docs are 3.0.5).
- Split filter state into a pure module + one shared FilterPanel (sidebar / drawer shells).
- INCIDENT: `git stash` is shared across sibling worktrees; a push/pop raced T34 and swapped working trees. Recovered from the dangling stash commit; T34's work re-saved at /tmp/t34-rescue. Never use `git stash` in these worktrees.
- Measured in Chrome on the production build at 375/768/1024/1440, both themes.

## Outcome
- Changed: `frontend/src/pages/recommend/{RecommendPage.tsx,FilterPanel.tsx,filterState.ts,filterState.test.ts,RecommendPage.test.tsx}`, `frontend/src/components/ui/Drawer.tsx` (additive `footer` prop), `frontend/src/styles.css` (two fenced T33 blocks + 9 legacy-rule deletions).
- Verified: 195 tests / 21 files green, `tsc -b` 0 errors, `pnpm build` ok. Bundle gz JS +16.8 kB (+6.7%), gz CSS +1.7 kB (+0.7%).
- Measured at 375px: query box to first result card 0.84 screens (was 2.08 collapsed / 3.18 expanded); no horizontal scroll at any width; all drawer controls and tag remove buttons >=44px; drawer traps focus (siblings `inert`), closes on Escape and on swipe-down, and commits the draft on close.
- Follow-ups for T41: dark mode on this page is capped by the legacy unlayered `html{background:#f3f5f1}` and the shadowed `--muted`; light mode is all >=4.5:1.
