# 10-upgrade-stack-atomic

- Status: done
- Depends on: 01, 02, 03 (all done)

## Goal
Upgrade React 19 / Vite 8 / react-router 8 / Vitest 4 / jsdom in ONE commit
(peer deps make them inseparable). Upgrade only — no UI or behaviour change.
Baseline to preserve: 134 tests green, tsc -b clean, build ok.

## Progress
- context7 MCP quota exhausted as expected; versions re-verified via npm registry API.
- All plan versions confirmed unchanged; no new major breaks the peer graph.
- Installed react/react-dom 19.2.8, react-router 8.3.0, removed react-router-dom.
- Installed vite 8.2.2, @vitejs/plugin-react 6.1.0, vitest 4.1.11, jsdom 30.0.1, @types/react 19.2.18, @types/react-dom 19.2.4.
- Router imports switched in src/main.tsx and src/App.tsx (2 lines).
- types-react-codemod preset-19: 0 modifications / 35 files — source already React 19 clean.
- Audited refs by hand: both callback refs already block-bodied; no bare useRef().
- vitest.config.ts: added plugin-react, test.dir "src", globals true.
- tsconfig.node.json: vitest.config.ts added to include.
- Kept explicit afterEach(cleanup) deliberately; stale comment rewritten.
- pnpm-workspace.yaml untouched — no new native postinstall dependency.
- Gates: 134/134 tests, tsc -b 0 errors, build ok, frozen-lockfile ok.
- CI gate re-verified with a real pnpm 10 clean install; lockfile byte-identical.
- Manual devtools pass over all 5 routes: zero React/runtime console errors.
- Schedule grid roving tabindex driven with real arrow keys: callback-ref map intact.

## Outcome
Single commit e239da6 on refactor/frontend-redesign.
Files: frontend/package.json, frontend/pnpm-lock.yaml, frontend/vitest.config.ts,
frontend/tsconfig.node.json, frontend/src/main.tsx, frontend/src/App.tsx,
frontend/src/ScheduleWorkspace.test.tsx.
Bundle: JS 316.83 -> 372.71 kB, CSS 40.52 -> 40.29 kB.
