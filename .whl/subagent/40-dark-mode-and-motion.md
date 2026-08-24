# 40-dark-mode-and-motion

Status: done

## Progress
- worktree reset onto refactor/frontend-redesign @0143ce9 (T41a); pnpm install ok
- baseline measured: pnpm test 253/26, tsc 0, build ok, pytest 39
- design gate: ui-ux-pro-max (ux + web), heroui-react MCP (list_components, get_theme_variables, theming doc), magicuidesign-mcp (3 registry items, sources read + verified)
- context7 quota exhausted -> motion API verified from node_modules/framer-motion@13.1.1 types
- pnpm add motion@13.1.1
- new files: frontend/src/hooks/theme.tsx, frontend/src/hooks/useReducedMotion.ts,
  frontend/src/components/motion/{ThemeToggle,BlurFade,NumberTicker}.tsx
- new tests: frontend/src/hooks/theme.test.tsx, frontend/src/components/motion/motion.test.tsx
- frontend/src/data/db.ts: DB_VERSION 1->2, added `preferences` store, excluded from clearPersonalData
- frontend/index.html: inline classic <head> script paints data-theme from a localStorage mirror before first paint
- frontend/src/styles.css: reduced-motion block extended (--skeleton-animation:none, ::view-transition-*),
  view-transition reveal CSS, toggle placement, .result-reveal grid box
- frontend/src/test/setup.ts: IntersectionObserver stub (jsdom ships none; motion useInView needs it)
- no motion barrel: AppShell imports ThemeToggle by module, else motion lands in the entry chunk (measured)

## Outcome
- pnpm test 268/28 green, npx tsc -b 0, pnpm build ok, pytest 39
- 5 routes x light/dark x 375/768/1024/1440: 0 contrast failures.
  light floor 4.98 (schedule grid), dark floor 5.41-equivalent measured 5.61.
  focus ring 7.77:1 light / 9.21:1 dark. No regression vs baselines.
- Lighthouse a11y 100 on /schedule /recommend /explore; /data still 95 (pre-existing HeroUI Meter aria-allowed-attr)
- reduced motion proved via CDP Emulation.setEmulatedMedia (the MCP `emulate` tool has no such option):
  idle getAnimations()==0, NumberTicker 381 samples/1 value, BlurFade 18 samples/1 frame with no inline styles,
  startViewTransition never called, peak transition duration 0.01ms
- no theme flash: same-origin iframe polling shows data-theme already correct at the child's first paint entry, both directions
- bundle: JS +137.9 kB raw / +46.8 kB gzip, all in lazy route chunks; first-load JS +10.8 kB raw / +4.7 kB gzip. CSS +1.2 kB raw / +343 B gzip.

Status: done
