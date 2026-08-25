# 02-extract-inline-logic

- Status: done
- Depends on: 00-config-cruft-fix (parallel with 01)

## Goal
Move pure logic out of `App.tsx` / `ScheduleWorkspace.tsx` into `domain/`, dedupe
the two conflicting eligibility label sets and the duplicated `weekdays`, add tests
for the previously untested functions. No behaviour or visual change.
Also fix the dead `setCompletionAnnouncement` aria-live region (a11y, repair not delete).

## Progress
- start: worktree agent-a5f2db680c71c1ade, pnpm install ok, baseline 100 tests green
- new `frontend/src/creditFilter.ts` (+ `.test.ts`): HIGH_CREDIT_THRESHOLD + 4 helpers
- `frontend/src/schedule.ts`: + weekdayLabels, weekPatternLabel, formatMeetings, parseManualSections, unplacedBlock
- `frontend/src/eligibility.ts`: + eligibilityStatusLabels (long) + eligibilityStatusShortLabels (short)
- `frontend/src/scheduleUtils.ts`: + ACTIVE_SCHEDULE_PREFERENCE_ID + ActiveSchedulePreference
- `App.tsx` / `ScheduleWorkspace.tsx`: imports only; `weekdays` renamed `weekdayLabels`; reverse import removed
- cleanups: unused `Warning` / `getRecord`; dead `validationSummaryRef` removed (rendered DOM unchanged)
- a11y: aria-live now announces on AI answer success (`AssistantPage.ask`)
- moved the one `formatMeetings` test out of `ScheduleWorkspace.test.tsx` into `schedule.test.ts`
- verify: pnpm test 134 green | npx tsc -b 0 errors | pnpm build ok

## Outcome
Done. Branch `worktree-agent-a5f2db680c71c1ade`, commit `381e8833c76420d703704acb7631de4a43e748f5`.

All four eligibility statuses had DIVERGING copy between the two label sets, so both
wordings were kept (in one module, `eligibility.ts`) and every call site still renders
its original text:

| status | App.tsx `eligibilityStatusLabels` | ScheduleWorkspace `eligibilityStatusShortLabels` |
|---|---|---|
| no_known_restriction | 尚未判定出明確限制 | 未見限制 |
| eligible_confirmed | 條件已符合 | 資格符合 |
| blocked_confirmed | 目前不可修 | 資格不符 |
| needs_confirmation | 需要確認 | 資格待確認 |

Note for T01 integration: `ScheduleWorkspace.test.tsx` was touched (import line + the
moved `formatMeetings` test block) - expect a conflict with the concurrent test rewrite.
