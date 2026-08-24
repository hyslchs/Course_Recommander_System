# 51-schedule-mobile-a11y

- Status: done
- Depends on: wave-3 review findings

## Goal
Fix /schedule: 117px h-scroll at 375 (missing scroll-shadow.css), 7-day picker overflow, role=grid without role=row (Lighthouse 90), invisible slot affordance, 11.3px class-block text, label-in-name, print clipping.

## Progress
- reset worktree to 1aa620a, pnpm install ok
- design gate: ui-ux-pro-max (ux + web domains), heroui-react MCP (ScrollShadow, ToggleButtonGroup, Tabs) re-verified against node_modules 3.2.4, magicuidesign-mcp searched (motion-only, nothing applied)
- P1-a: added scroll-shadow.css import; audited all transitive HeroUI deps, it is the only genuinely missing one
- P1-b: mobile-day-picker label stacked above the group; 7 x 46.7x44 at 375
- P1-c: role=row wrappers + per-block role=gridcell wrapper, both display:contents
- P2-d: slot label visible at rest, 13px; reveal state darkened
- P2-e: .class-block small 13px + darker colour
- P2-f: measured axe's rule (ASCII punctuation only is stripped) -> classBlockLabel format changed, 3 tests updated
- P2-g: --schedule-col-min print override + @page A4 landscape
- P3-h/i: chevrons 44x44 + zh labels; eyebrow 13px
- verified: pnpm test 233/26, tsc 0, build ok, Lighthouse a11y 100 desktop + mobile, print measured at 1047px and 718px

## Outcome
All eight defects addressed. One residual: `label-content-name-mismatch` still reports 1 item on the
mobile day-list row (mobile only, unscored audit) — fixing it needs a variant-specific accessible name,
which contradicts the T01 shared-label handoff. Files: frontend/src/styles.css (one fenced block at the
end + one @import), frontend/src/pages/schedule/{ScheduleWorkspace,ClassBlock}.tsx and their two tests.
