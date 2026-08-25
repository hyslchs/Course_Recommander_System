# 41b-css-shrink-and-fonts

- Status: done
- Depends on: 41a-legacy-css-teardown, 40-dark-mode-and-motion (both done)

## Goal
Execute the three-tier font decision (.whl/plan/decision-fonts.md), shrink
styles.css, add forced-colors support, re-audit print, and close the OFL
licence gap.

## Files
- new: `frontend/scripts/build-fonts.py`, `frontend/scripts/font-tiers.py`,
  `frontend/scripts/font-tiers/tier{1,2}.txt`, `frontend/public/assets/OFL.txt`
- edited: `frontend/src/theme/fonts.css`, `frontend/src/theme/typography.css`,
  `frontend/src/styles.css`, `frontend/vite.config.ts`,
  `frontend/package.json`, `frontend/src/pages/schedule/ManualCoursePanel.tsx`,
  `Dockerfile`, `.github/workflows/ci.yml`, `.gitignore`

## Progress
- reset worktree to e837957 (T40 + T41a present); `pnpm install`
- baseline re-measured: 268 tests / 28 files, tsc 0, pytest 39, built CSS
  794,584 B raw / 250,545 gzip, 459 dist files
- design gate: ui-ux-pro-max `scripts/search.py` (ux/web/typography);
  heroui-react MCP `get_theme_variables` + theming doc; magicuidesign-mcp
  `searchRegistryItems` (nothing applied)
- decision doc has NO §10 sketch and `/tmp/fontlab` was already gone, so the
  pipeline was rebuilt from scratch against the doc's stated design
- verified the 5 per-subset fontsource files are NOT equivalent to the 105
  slices (6,828 vs 12,153 codepoints) — the merge really is required
- build-fonts.py: fontTools.merge of 105 slices/weight -> 3 tiers x 4 weights,
  `--layout-features='*'`, `--name-IDs='*'`, woff2; 7,669,420 B total, matching
  the decision doc's 7.67 MB exactly
- coverage proven identical: 12,153 cp in, 12,153 out, 0 lost, advance widths
  unchanged
- Inter removed; `--font-latin`/`--font-cjk`/`--font-mono-latin` collapsed into
  one live `--font-sans` in a NON-inline `@theme` (that is why it used to
  resolve to the empty string); `html` no longer hard-codes its stack
- `dropLegacyWoffFallback` plugin deleted
- OFL: `--name-IDs='*'` keeps nameID 0 + 14; OFL.txt committed in `public/` so
  it lands in `dist/assets/`; build fails if it drifts from @fontsource
- CSS deletions, each verified dead first: `.status*`, `.category-tag*`,
  `.department-*`, `.notice`, `.danger`, `.contents-fieldset`,
  `.course-skeleton*`, `.skeleton-grid`, `@keyframes skeleton-pulse`,
  `.inline-empty`, `.applied-filter-list`, `.filter-group-content`
- `--green`/`--lime` are NOT dead (25 and 5 live declarations) — kept
- `.card` collision retired: ManualCoursePanel drops the bare class, the legacy
  `.card{}` rule is deleted, T36's `[data-page="data"]` revert is gone
- forced-colors block added; print re-audit added 3 fixes
- `[id]{scroll-margin-top}` 92/78 -> 72/64 to match the measured topbar
- Docker + CI wired (apk python3/py3-brotli + fonttools; CI regenerates the
  tier lists and `git diff --exit-code`s them)

## Outcome
- Built CSS 794,584 -> 306,709 B raw; gzip 250,545 -> 36,548. Render-blocking
  CSS on the wire (GZipMiddleware, no brotli) 247,903 -> 38,529 B.
- `@font-face` 420 -> 12, `unicode-range` occurrences 329,960 B -> 0.
- dist without .map: 11,005,774 B / 433 files -> 9,127,956 B / 42 files.
  Docker runtime dist 8.8M / 42 files (was ~12M / 433).
- Cold /explore: font requests 42 -> 4, total requests 65 -> 27, total transfer
  1,991,034 -> 1,514,291 B.
- `document.fonts.check()` true for all three families x 4 weights; only tier 1
  is fetched on a natural load.
- A/B vs a pre-change build served from outside the project tree: /onboarding,
  /explore, /data, /schedule all 0 element-rect differences and identical
  document heights; residual pixel deltas 43-103 px >128 of 1.296 M
  (anti-aliasing). ONE intentional change on /recommend — its HeroUI Cards now
  use HeroUI's 16px padding instead of the legacy 22.4px, which is the point of
  retiring the collision and makes it agree with /data and /assistant.
- 5 routes x 2 themes x 4 widths (40 configs): 0 contrast failures, 0
  page-level horizontal scroll. Light floor 5.29, dark floor 5.49 — the same
  5.49 measured on the BASELINE build with the identical sampler, so no
  regression (T41a's 5.61 came from a different instrument).
- Focus ring 7.77:1 light / 9.21:1 dark, unchanged.
- Lighthouse a11y 100 on /schedule /recommend /explore, 95 on /data
  (pre-existing Meter `aria-allowed-attr`); best-practices 100, SEO 91.
- forced-colors: rules ship and reach live elements; with every fill flattened
  the timetable still separates normal / fixed / conflict by border STYLE
  (1px solid / 2px dashed / 3px double) plus the existing wording and glyph.
- Print at A4-landscape width: all SEVEN day columns render, 72px + 7x137px =
  1031px inside the 1047px box, 0 overflow.
- `styles.css` did NOT reach ~120 lines (1,341). The legacy minified region did
  shrink, but most of the file is the import block, the `@theme` tokens and the
  T30-T41a page-migration fences, all still load-bearing.
