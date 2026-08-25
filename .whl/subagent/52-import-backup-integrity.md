# 52 — importBackup data integrity

Status: done

## Progress
- Reset worktree to 1aa620a; frontend deps installed.
- Read `frontend/src/data/db.ts` + `frontend/src/data/db.test.ts`. Only caller of `importBackup`/`putRecords` is `frontend/src/pages/data/DataPage.tsx`; no signature change, so no caller edits.
- Extended the hand-rolled fake IndexedDB in `db.test.ts`: multi-store transaction scope, buffered writes applied only at commit (real rollback), `abort()`/`onabort`, and a `failWritesTo` injection hook.
- Wrote both reproductions first; confirmed red on the unfixed code (duplicate ids → 1 plan instead of 2; mid-import failure → 4 completedCourses committed, 0 events).
- Fixed `db.ts`: claimed-id set seeded from the store and extended in-batch; new `writeBatches` writes every store in one transaction; failure path notifies then rethrows.
- Both reproductions green after the fix.

## Outcome
- Files changed: `frontend/src/data/db.ts`, `frontend/src/data/db.test.ts` only. No caller changes.
- Atomicity: full — one `readwrite` transaction spanning every target store, so the import commits or rolls back as a unit. Trade-off documented in the report: the pre-write read of existing plan ids is a separate readonly transaction (pre-existing TOCTOU window across tabs, unchanged), and an unknown key in `backup.data` now fails the whole import instead of a prefix.
- `putRecords` audited: structurally immune (no per-row decisions); duplicate-id collapse is the wanted semantics for its one caller. Pinned by a test.
- Verified: `pnpm test` 235/26 files, `npx tsc -b` clean, `pnpm build` ok, backend `pytest -q` 39 passed.
- Commit `98d86d5` `fix(frontend): make backup import atomic and collision-safe (FIX52)` on worktree branch `worktree-agent-a8cb7fb3b155cc4ab` (based on 1aa620a).
