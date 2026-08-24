# 41a-legacy-css-teardown

Status: done

Files: `frontend/src/styles.css`, `frontend/src/theme/fju.css`,
`frontend/src/pages/explore/CourseTable.tsx` (comment only).

## Progress
- reset worktree to 2b163c8; `pnpm install`
- design gate: ui-ux-pro-max `scripts/search.py` (ux + web: focus states, colour
  contrast, colour-not-the-only-indicator); heroui-react MCP `get_theme_variables`
  + `list_components`, token names re-verified against
  `node_modules/.pnpm/@heroui+styles@3.2.4/.../dist/themes/default/variables.css`;
  magicuidesign-mcp `searchRegistryItems` (nothing applied — motion is T40)
- deleted both unlayered legacy `:root` rules (token shadowing + page background)
- moved legacy `button{}` / `input,select,textarea{}` into `@layer base`,
  qualified `:not([data-rac])` so React Aria controls keep HeroUI's box
- topbar hard-coded `background:#fff` removed, re-bound to `--surface`
- `--surface-secondary` / `--surface-tertiary` (+ `-foreground`) defined for
  `[data-theme="fju-dark"]` in `theme/fju.css`; T34's page-scoped stopgap deleted
- timetable palette de-hardcoded to tokens; conflict hatch kept as a texture
- removed FIX50 rules 1+2, T30's overlay/toast `revert-layer` patches, T35's
  drawer twin, T36's scoped `--danger`/`--muted`; kept FIX50 rules 3+4 and
  T36's `.card` revert (reasons in the source comments)
- deleted the verified-dead list from tasks.md T41 plus the dead legacy
  `.toast*` / `.modal-*` / `.schedule-dialog` box / `.profile-form` families
- verification: 253 tests / 26 files, `tsc -b` 0, `pnpm build` ok, pytest 39
- browser sweep on the production build (chrome-devtools MCP), real-pixel
  contrast via canvas `getImageData`, A/B against a clean pre-change build

## Outcome
- LIGHT did not regress: 559 elements sampled per theme, matched route-for-route,
  0 -> 0 contrast failures, floor 4.59 -> 4.98. Viewport pixel A/B: 0 pixels
  above 32/255 on /onboarding and /explore; the small remaining bands on
  /recommend, /schedule, /data are text glyphs recoloured by the un-shadowed
  `--muted` / `--danger` / `--ink` tokens (verified by crop).
- DARK: 60 -> 0 contrast failures, floor 1.09 -> 5.41.
- Share of light pixels under `fju-dark`, full page @1440
  (baseline measured here / after): schedule 91.6% -> 0.5%, recommend
  65.3% -> 0.6%, onboarding 63.0% -> 0.8%, data 51.8% -> 0.6%,
  explore 33.1% -> 1.2%.
- Focus ring is now the accent: #1A4E8A light (7.77:1 on `--background`),
  #8CB8F0 dark (9.21:1). Confirmed rendering by keyboard Tab.
- No page-level horizontal scroll at 375/768/1024/1440 in either theme; no
  HeroUI control rendering as an unstyled legacy box.
- Lighthouse accessibility 100 on /schedule, /recommend, /explore; /data 95
  (pre-existing `aria-allowed-attr` on Meter). SEO 91 / best-practices 100 match
  the baseline build exactly.
- CSS SIZE DID NOT SHRINK. Built CSS 792,623 -> 793,412 bytes (+789).
  Source `styles.css` 101,521 -> 95,907. 486 kB of the built file is
  fontsource's unicode-range block and most of the rest is Tailwind preflight +
  HeroUI components; the legacy declarations removed were replaced by
  token-based equivalents of similar size. Real shrinkage belongs to T41b.
  (Trap for the next agent: a `dist-*/` directory left inside `frontend/` is
  scanned by Tailwind and inflates the built CSS by ~12 kB.)

## Left for T41b
- `.card` name collision with HeroUI (T36's `[data-page="data"]` revert kept)
- `.course-card{background:#fff}` literal (T31's token binding still needed)
- remaining dead legacy families not on the verified list: `.status*`,
  `.category-tag*`, `.department-*`, `.notice`, `.danger`
- `--green` / `--lime` still exist as legacy brand aliases (light values
  unchanged by design; dark values derived)
