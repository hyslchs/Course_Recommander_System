# 01-detest-classnames

- Status: done
- Depends on: 00-config-cruft-fix

## Goal
Rewrite the 6 CSS-class-coupled DOM tests in `ScheduleWorkspace.test.tsx` to
role/accessible-name queries via @testing-library/react, so later JSX/CSS churn
can't redden CI. Test-file-only commit; green before and after.

## Progress
- Baseline `pnpm test` green: 100 tests / 14 files.
- Mapped rendered structure of `ScheduleWorkspace.tsx` + `ui.tsx` Modal to roles/accessible names.
- Migrated file to `@testing-library/react` (`render`/`screen`/`within`/`userEvent`), dropped `createRoot`+`act`.
- All 11 class-name selectors replaced by role + accessible-name queries; explicit `cleanup()` added (vitest has no `globals: true` yet).
- context7 MCP quota exhausted; used official testing-library.com ByRole docs instead.
- Verified: `pnpm test` 100/100 (14 files), `npx tsc -b` 0 errors, `pnpm build` OK, `git diff --stat -- frontend/src/` = 1 file.

## Outcome
- Only file changed: `frontend/src/ScheduleWorkspace.test.tsx` (66+/68-).
- No production file touched; `frontend/src/ui.test.tsx` untouched.
- Remaining non-role query: the compact-mode hidden notice (`ScheduleWorkspace.tsx:506`) has no role, queried via `getByText`.
