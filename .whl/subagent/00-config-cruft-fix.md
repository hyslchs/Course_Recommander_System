# 00-config-cruft-fix

- Status: done
- Depends on: none

## Goal
Remove the blockers that make every later config change silently ineffective:
`vite.config.js` build artifact in VCS, missing `noEmit`, floating Node tags,
dep/devDep misplacement, dead `allowBuilds` block, public sourcemaps.

## Progress
- Baseline confirmed: pnpm test 14 files / 100 tests green; vite.config.js + vite.config.d.ts confirmed tracked in git.
- Added `noEmit: true` to frontend/tsconfig.node.json; verified TS 5.9.3 accepts composite+noEmit (empirical, docs pages were circular).
- git rm --cached + deleted frontend/vite.config.js and frontend/vite.config.d.ts; added both to .gitignore with a why-comment.
- Pinned Node: Dockerfile node:24.15-alpine (tag verified on Docker Hub), .github/workflows/ci.yml node-version 24.15.
- Moved typescript / vite / @vitejs/plugin-react to devDependencies in frontend/package.json.
- Regenerated frontend/pnpm-lock.yaml (required: importers records the dep/devDep split, else CI --frozen-lockfile fails). Diff is importers-only, lockfileVersion stays 9.0.
- Set build.sourcemap to "hidden" in frontend/vite.config.ts; verified no sourceMappingURL in dist assets.
- DEVIATION on pnpm-workspace.yaml: left unchanged at HEAD (see Outcome). Deleting `allowBuilds` hard-fails local pnpm 11.9.0.
- Proof 1 PASSED: console.log in vite.config.ts appeared in pnpm dev output ("T00 config live"), then removed.
- Proof 2 PASSED: tsc -b --force --listEmittedFiles lists only the two .tsbuildinfo files.
- Verified: pnpm install --frozen-lockfile exit 0, pnpm test 14/100 green, npx tsc -b exit 0, pnpm build exit 0.

## Outcome
Changed: frontend/tsconfig.node.json, frontend/vite.config.ts, frontend/package.json, frontend/pnpm-lock.yaml, .gitignore, Dockerfile, .github/workflows/ci.yml; deleted frontend/vite.config.js + frontend/vite.config.d.ts (staged as D, now gitignored).
Verified by running all five checks: pnpm test 14 files/100 tests green, npx tsc -b 0 errors, pnpm build ok, dev-server console.log proof appeared (config is now live), listEmittedFiles emits no vite.config artifacts.
DEVIATION: frontend/pnpm-workspace.yaml left at HEAD (`allowBuilds` + `onlyBuiltDependencies` both kept). pnpm docs state `onlyBuiltDependencies` was REMOVED in pnpm v11 and replaced by `allowBuilds`; local pnpm is 11.9.0, so deleting `allowBuilds` makes pnpm install/dev exit 1 (ERR_PNPM_IGNORED_BUILDS). Keeping both is the only form valid for CI/Docker pnpm 10 and local pnpm 11 simultaneously.
Follow-ups: decide a single pnpm major (add `packageManager` to package.json) so the workspace file can drop one key; Dockerfile `corepack enable` is unpinned; the 1.2MB .map is still written into dist/ and would be served if dist is copied wholesale.
