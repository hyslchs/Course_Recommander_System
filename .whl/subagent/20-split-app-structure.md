# 20-split-app-structure

- Status: done
- Depends on: 11-tailwind-heroui-tokens (done)

## Goal
Split the 1185-line `App.tsx` into `app/ pages/ components/ hooks/ data/ domain/`,
add `@/*` alias in all THREE configs, route-level React.lazy + Suspense,
ErrorBoundary and a 404 route, and fix the single-`<h1>`-per-route contract.
Pure move + wiring — no visual or behaviour change.

## Progress
- Read plan §6.1/§6.2/§3.5/R9 + task spec; audited App.tsx (1145), ScheduleWorkspace.tsx (494), ui.tsx, configs.
- Found real double-`<h1>`: ScheduleWorkspace :463 + :465 render together when no plan exists.
- `git mv`ed 13 domain modules + types into `domain/`, api/db into `data/`, ui into `components/`.
- Page bodies sliced out of the original file with `sed`, so page JSX is byte-identical; only imports are new.
- `@/*` alias added to tsconfig.app.json, vite.config.ts and vitest.config.ts (`"@": "/src"`, no @types/node needed).
- SlotRecommendationDialog 11-prop bag → `SlotRecommendationContext`; dialog now takes zero props (JSX diffed identical).
- Lazy routes + Suspense + ErrorBoundary (keyed by pathname) + `*` 404 via EmptyState.
- RouteFocusManager rewritten: MutationObserver over `#main-content`, first heading always focused, replacement heading reclaims focus only if it was dropped.
- Fixed a pre-existing focus bug this exposed: /schedule dropped focus to `<body>` when the loading panel swapped the heading out.
- Verified in Chrome: 5 routes + unknown path, one h1 each, focus on h1, no console errors, ErrorBoundary probe, grid roving tabindex, modal inert/Escape/return-focus.
- 144 tests / 17 files green, `tsc -b` 0 errors, build emits 14 JS chunks (was 1).

## Outcome
- `frontend/src/{app,pages,components,hooks,data,domain}/**` — new layout; `app/App.tsx` is 41 lines.
- New: `app/routes.tsx`, `app/AppShell.tsx`, `app/ErrorBoundary.tsx`, `app/RouteFocusManager.tsx`, `pages/schedule/SlotRecommendationContext.ts`.
- Tests: `app/routeHeadings.test.tsx` (one-h1 per route + focus), `app/ErrorBoundary.test.tsx`.
- One CSS line appended to `styles.css`: `.page-title` keeps demoted h2 headings pixel-identical to the old h1.
