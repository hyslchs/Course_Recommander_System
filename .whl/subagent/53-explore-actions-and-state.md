# 53-explore-actions-and-state

Status: done

## Progress
- Reset worktree to 1aa620a; `pnpm install`.
- Design gate: ui-ux-pro-max (ux/web/react), heroui-react MCP (Table/Tooltip + node_modules 3.2.4 re-check), magicuidesign-mcp (2 searches, nothing applicable).
- A: new `frontend/src/pages/explore/CourseRowActions.tsx` — add-to-schedule + favourite, icon-only, aria-label + Tooltip.
- A: `frontend/src/pages/explore/CourseTable.tsx` — 8th 操作 column, `sortable` flag on ColumnSpec, non-sortable header.
- B: new `frontend/src/pages/explore/useLayoutSwitchFocus.ts` — focus handoff + polite announcement, modelled on `app/RouteFocusManager.tsx`.
- B: `frontend/src/pages/explore/ExplorePage.tsx` — owns `sortDescriptor`; results region is `role=region` + `tabIndex=-1`; persistent sr-only live region.
- Tests: obsolete "table deliberately does not carry the action" assertion replaced; live matchMedia stub so the breakpoint can be flipped mid-test.
- Negative control: reverted each fix in turn, the new tests fail; restored.
- Headless Chrome over raw CDP found the focus gate never armed (`document.hasFocus()` false suppresses `focusin`). Made the gate fail-open, added a regression test.
- Re-verified in Chrome: focus lands on the region, ring is real, both actions write to IndexedDB.

## Outcome
- `pnpm test` 240 passed / 26 files (baseline 232). `npx tsc -b` 0 errors. `pnpm build` ok.
- Bundle: ExplorePage chunk 103.96 -> 113.38 kB raw (gzip 32.10 -> 34.66 kB); all dist JS 995,333 -> 1,004,703 B (+0.94%).
- Known follow-up: `CourseRowActions` transcribes CourseCard's handler orchestration; the shared `useCourseActions` hook could not be extracted because the task confines changes to `pages/explore/**`.
- `frontend/src/styles.css` untouched.
