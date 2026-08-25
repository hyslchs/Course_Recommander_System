# 11-tailwind-heroui-tokens

- Status: done
- Depends on: 10-upgrade-stack-atomic (done)

## Goal
Lay the design-system foundation: Tailwind v4 + HeroUI v3 + the FJU light/dark
oklch token set, plus I18nProvider(zh-Hant-TW). **Visual output must not change** —
the existing styles.css still wins. Foundation only, no component migration.

## Progress
- read plan §4.1/4.2/4.4 + tasks.md T11 (with corrections)
- design gate: ui-ux-pro-max (design-system + typography + ux domains), heroui-react MCP (theming doc + get_theme_variables), magicuidesign-mcp (77 items, nothing applicable to T11)
- context7 tried, quota exhausted; versions verified against npm registry API
- installed tailwindcss 4.3.3, @tailwindcss/vite 4.3.3, @heroui/react 3.2.4, @heroui/styles 3.2.4
- captured before-state pixel + computed-style baselines for /recommend and /schedule at 1280 and 375
- token oklch values + WCAG contrast computed from the plan's hex table, not eyeballed
- `@import "@heroui/styles"` barrel took CSS 40.29 -> 454.21 kB; switched to HeroUI's documented selective import
- Tailwind preflight measurably changed rendering (headings collapsed, line-height, p margin, svg display); preflight deferred with a documented re-enable note
- renamed private primitives to --fju-* after legacy unlayered :root shadowed --paper/--ink
- three tokens (--muted/--danger/--focus) stay shadowed by legacy on purpose; documented in styles.css
- verified: pixel-identical on both routes at both widths, 25/30 tokens flip with data-theme, dark: variant compiles against fju-dark, useLocale() = zh-Hant-TW
- 134 tests / 15 files green, tsc -b 0 errors, build ok, clean install ok on pnpm 11.9.0 and 10.34.5

## Outcome
CSS 40.29 -> 70.74 kB (gzip 9.35 -> 12.44); JS 372.71 -> 374.57 kB. Rendered
output byte-identical (pixel diff bbox None at 1280 and 375 on /recommend and
/schedule).

- `frontend/src/theme/fju.css` (new), `frontend/src/theme/typography.css` (new)
- `frontend/src/styles.css` (prepended only), `frontend/src/main.tsx`,
  `frontend/index.html`, `frontend/vite.config.ts`,
  `frontend/pnpm-workspace.yaml`, `frontend/package.json`, `frontend/pnpm-lock.yaml`

Deferred with in-file notes: Tailwind preflight (re-enable in the first task
using a Tailwind utility or HeroUI component); self-hosted Noto Sans TC
(@fontsource, 424 woff2 / ~14 MB for the four permitted weights — belongs in
the typography task, no CDN wired up).
