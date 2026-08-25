# 03-dead-code-purge

- Status: done
- Depends on: 01-detest-classnames (done)

## Goal
Delete 17 unused CSS classes (~3.5KB), fix 4 applied-but-never-defined classes
(incl. the real `.secondary` cancel-button bug), define missing `var(--card)`,
delete the two-generations-old `src/fju_outline/web_assets/`, and make
`web.py`'s static-dir fallback raise instead of silently serving the old UI.

## Progress
- Agent was stopped by the user mid-task; orchestrator assessed the partial tree and finished verification + commit.
- All 17 dead classes confirmed deleted; `.schedule-dialog-backdrop` also removed from the `@media print` hide-list.
- 4 undefined-but-applied classes now defined (`.secondary`, `.toast-success`, `.occupied`, `.recommendation-reasons`).
- `var(--card)`: its single reference lived inside a deleted dead rule, so resolved by deletion, not definition. Nothing references it now.
- `styles.css` not reformatted (R4 honoured): 43392 -> 40481 bytes raw.
- `web.py`: `LEGACY_STATIC_DIR` + `/static` mount removed; new `FrontendBuildMissingError` + `_resolve_frontend_dist()`; frontend routes answer 503 with an actionable build command.

## Outcome
Changed: `frontend/src/styles.css`, `src/fju_outline/web.py`; deleted `src/fju_outline/web_assets/`. Commit `41bc58f`.
Verified: 134/134 frontend tests, `tsc -b` 0 errors, `pnpm build` ok, CSS 43.51 -> 40.52 kB (gzip 9.35 -> 8.76), backend 39/39.
Fail-loud path proven by moving `frontend/dist` aside: `/` returns 503 with the build instructions, while `/health/ready` still returns its own JSON (catch-all does NOT shadow API routes, so the Docker HEALTHCHECK is safe).
Note: backend deps are not installed system-wide (PEP 668). A throwaway venv at `/tmp/fjuvenv` runs `pytest` — reuse it for later backend checks.
