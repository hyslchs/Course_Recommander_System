# 12-self-host-fonts

- Status: done
- Depends on: 11-tailwind-heroui-tokens (done)

## Goal
Self-host Noto Sans TC (weights 400/500/600/700 only) as unicode-range woff2
subsets with font-display: swap. No CDN. Deferred by T11 and previously
unowned; must land before the T31-T36 UI wave so responsive verification uses
real CJK metrics.

## Progress
- worktree had branched off `main`; reset to refactor/frontend-redesign (e2da5f3, T20)
- npm registry: @fontsource/noto-sans-tc latest still 5.3.0 (pub 2026-07-19), 68.2 MB / 1977 files, OFL-1.1
- styles.css:125 `:root{font-family:"Noto Sans TC","Segoe UI",...}` - Noto is already first, so @font-face repaints Latin too
- design gate: ui-ux-pro-max (typography+ux: Noto Sans TC = recommended TC body font, font-display swap, similar fallback to limit CLS); heroui-react MCP get_theme_variables + theming doc (HeroUI v3 has NO font token at all - inherits document font-family, so no HeroUI wiring needed); magicuidesign-mcp searchRegistryItems "font typography self-host webfont" -> 1 hit (kinetic-text, hover font-weight animation) = nothing applicable, stated explicitly
- context7 quota exhausted as expected; version verified via registry.npmjs.org
- chose fontsource's unicode-range-sliced `<weight>.css` (105 rules x 4) over the per-subset `chinese-traditional-<w>.css` (1 face, 997 kB, no unicode-range = ~4 MB per cold view)
- measured 5,179 distinct codepoints of data/**.json + frontend/src against fontsource unicode.json: 103 of 105 slices are actually hit -> pruning slices not viable
- added `fju-drop-legacy-woff-fallback` Vite plugin (generateBundle): strips fontsource's legacy .woff twin, 408 files / 11.5 MB. dist 23.3 -> 11.8 MB, 839 -> 431 assets
- tsconfig.node.json had no `target` (defaulted ES5); pinned ES2022 so the plugin typechecks
- verified on prod build: document.fonts.check true, 420 faces declared, 15 woff2 / 491 kB on /recommend, 0 .woff requests
- 144 tests green (unchanged), tsc -b 0 errors, build ok, --frozen-lockfile install ok

## Outcome
Done. @fontsource/noto-sans-tc@5.3.0 (OFL-1.1, still latest) as an npm dep;
weights 400/500/600/700, unicode-range-sliced, font-display swap, no CDN, no
binaries in git.

CSS 70.87 -> 557.81 kB (gzip 12.49 -> 229.11) - all of it @font-face
unicode-range hex, the unavoidable price of CJK subsetting. JS unchanged
(400.7 kB total). dist 2.2 -> 11.8 MB / 431 assets, which is also the Docker
runtime image delta. Page view: 15 woff2, 491 kB.

Visual change is intended and reviewed: Han text now renders in real Noto Sans
TC 400/700 (previously the system fallback had no bold and font-synthesis:none
blocked faking it), Latin advances shrink ~9.6%, punctuation and line boxes
shift a few px. Pixel diff vs before: bbox spans the whole text column,
2.4% of pixels at 1280 and 5.8% at 375; total document height unchanged.

- `frontend/src/theme/fonts.css` (new)
- `frontend/src/styles.css`, `frontend/src/theme/typography.css` (stale
  "not self-hosted" note replaced; flagged that Inter in --font-latin is still
  unhosted and unowned)
- `frontend/vite.config.ts` (new woff-stripping plugin),
  `frontend/tsconfig.node.json` (target ES2022),
  `frontend/package.json`, `frontend/pnpm-lock.yaml`

Branch `worktree-agent-a91fb7fff89fb3491`, commit `0af17e6`, based on
`refactor/frontend-redesign` @ e2da5f3 (T20). package.json / pnpm-lock.yaml
will conflict with T21's @tanstack/react-query - only the one dep line is ours.

STILL OPEN (not T12's scope): `--font-latin` names "Inter var"/"Inter", which
is neither hosted nor installed; Latin currently renders in Noto Sans TC's own
Latin. Whoever wires --font-sans into the cascade must add
@fontsource-variable/inter or drop Inter from the token.
