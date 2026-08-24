# 36-data-assistant-pages

- Status: done
- Depends on: 30-ui-primitives-heroui (done)

## Goal
DataPage to Card/Meter/AlertDialog + fix importBackup event storm. AssistantPage minimal migration only (stays behind AI_ASSISTANT_VISIBLE=false).

## Progress
- worktree reset to 11e33fc; baseline green 177/19, tsc 0, build ok
- design gate: ui-ux-pro-max (ux + web), heroui-react MCP (list_components + docs), magicuidesign-mcp (3 searches)
- db.ts: importBackup batched, single fju-local-data event; putRecords added
- DataPage rewritten on Card/Meter/TextArea/Checkbox/Button + ConfirmDialog(AlertDialog)
- AssistantPage minimal migration (Card/TextArea/Button/Label); still hidden behind AI_ASSISTANT_VISIBLE=false
- styles.css: T36 fence (imports block + rules block)
- new tests src/data/db.test.ts (5) + src/pages/data/DataPage.test.tsx (7) + src/pages/assistant/AssistantPage.test.tsx (2)
- measured danger/muted token shadowing in fju-dark; scoped repair added inside the T36 fence
- found+fixed a self-inflicted broken CSS comment that was swallowing the token rule
- chrome-devtools MCP browser was being re-selected by sibling agents; ran the sweep in a dedicated CDP-driven Chrome instead
- verified 375/768/1024/1440 x fju/fju-dark on the production build; 191/22 green, tsc 0, build ok

## Outcome
Changed: frontend/src/data/db.ts (shared layer, importBackup batching + putRecords), frontend/src/pages/data/{DataPage.tsx,useStorageEstimate.ts,DataPage.test.tsx}, frontend/src/pages/assistant/{AssistantPage.tsx,AssistantPage.test.tsx}, frontend/src/data/db.test.ts, frontend/src/styles.css (two fenced T36 blocks, 112 insertions, 0 deletions).
Verified: pnpm test 191/22 green (was 177/19), npx tsc -b 0 errors, pnpm build ok; measured sweep at 375/768/1024/1440 x fju/fju-dark on the production build via a dedicated headless Chrome + CDP.
Follow-ups for T41: the scoped --danger/--muted repair and the three revert-layer blocks all die with the legacy :root; the same button/textarea/card shadowing still bites every unmigrated page. AssistantPage stays behind AI_ASSISTANT_VISIBLE=false and got the minimum migration only.
