# 21-data-layer-query

- Status: done
- Depends on: 20-split-app-structure (done)

## Goal
Introduce TanStack Query for the 7 GET endpoints only, collapse 6 inconsistent
loading/error patterns, fix the useStore O(N) IndexedDB amplification, and unify
profile + plans onto context. No visual change.

## Progress
- read plan 6.3/6.4 + task spec; baseline 144 tests / 17 files
- verified @tanstack/react-query latest = 5.102.2 on npm; installed
- measured BEFORE on production build @ :8080 — facets requested 2x per session;
  /explore with 25 cards: favorites 25 reads, completedCourses 26 reads;
  one favorite toggle re-read favorites 25x
- added data/queries.ts (7 GET hooks + 3 mutations), app/queryClient.ts,
  hooks/localData.tsx (single subscription + ProfileContext); deleted hooks/useStore.ts
- SchedulePlanContext gained a provider; plans/activePlan/selectPlan and profile
  no longer passed as props anywhere (routes, SchedulePage, ScheduleWorkspace, CourseCard)
- ScheduleWorkspace slotRequestRef kept deliberately (its sources are outside Query)
- ScheduleWorkspace.test.tsx now supplies QueryClient + ProfileContext + SchedulePlanContext
- measured AFTER — facets 1x; favorites/completedCourses 1 read each with 25 cards;
  favorite toggle = 1 re-read; inverted-latency filter race shows no stale rows
- 144 tests green, tsc -b clean, build 15 chunks (initial 232.27 kB, CSS 70.87 kB)

## Outcome
- `frontend/src/data/queries.ts`, `frontend/src/app/queryClient.ts`, `frontend/src/hooks/localData.tsx`
- `frontend/src/hooks/useSchedulePlans.tsx` (provider), `frontend/src/app/{App,AppShell,routes}.tsx`
- all six pages + `frontend/src/components/CourseCard/CourseCard.tsx` rewired to hooks/context
- commit `refactor(frontend): route API reads through TanStack Query (T21)`
