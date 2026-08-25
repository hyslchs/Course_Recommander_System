# T42 — 最終驗收報告 / Final Verification

**Branch**: `refactor/frontend-redesign` (43 commits ahead of `main`)
**Date**: 2026-08-25
**Build under test**: `frontend/dist` rebuilt at the start of this task; the running
backend was byte-verified to be serving exactly this build (see “Environment integrity”).
**Scope**: measurement and review only. No source file was edited.

---

## 0. Environment integrity (post-ENOSPC re-check)

The host root filesystem hit 100% during this task (parallel `docker compose build`).
Everything below was re-validated afterwards; **nothing had to be redone**, because the
server and the build survived intact:

| check | result |
|---|---|
| served `/` vs `dist/index.html` | md5 `cddcdf25…` **identical** |
| served `/assets/index-BUDkOBLD.css` vs disk | md5 `71ec8524…` **identical**, 306,709 B |
| `/assets/OFL.txt` | **200**, 4,314 B |
| all six routes + `/assistant` | **200** (SPA fallback) |
| `/health/ready` | **503 — `No module named 'sentence_transformers'`**. Expected: the model is not installed locally. Benign for frontend verification, but it is why no recommendation results could be produced (see §7). |
| representative contrast audit re-run after the incident | identical numbers (floor 7.06 on `/explore` dark, 231 text nodes sampled) |

`docker compose build` was **not** run by me (orchestrator’s job, reported done and verified).

---

## 1. What was tested

| # | Area | Method |
|---|---|---|
| 1 | Keyboard walkthrough | Real CDP key events via chrome-devtools MCP `press_key`; `focusin` trail recording |
| 2 | Lighthouse | `lighthouse_audit`, navigation mode, **desktop + mobile × 5 routes = 10 runs**, all reports parsed from JSON |
| 3 | Responsive | 375 / 768 / 1024 / 1440 × `fju` / `fju-dark` × 6 routes = **48 combinations**; theme driven through the **real toggle button**, not by setting the attribute |
| 4 | Contrast | Real-pixel resolution: computed colour assigned to `ctx.fillStyle`, read back with `getImageData` so Chrome performs the `oklch()` / `color-mix()` conversion. Alpha composited up the ancestor background stack. `scrollTo({behavior:'instant'})` + `scrollY===0` asserted before every capture. **No `oklch()` string was ever parsed.** |
| 5 | Reduced motion | `Emulation.setEmulatedMedia` over raw CDP (Node WebSocket client, browser on `127.0.0.1:9805`) — the MCP `emulate` tool has no such option |
| 6 | Print | `Emulation.setEmulatedMedia {media:'print'}` + `Page.printToPDF`, both with explicit A4 landscape and with `preferCSSPageSize:true` so the app’s own `@page{size:A4 landscape;margin:10mm}` drove it; PDFs read back page by page |
| 7 | forced-colors | `Emulation.setEmulatedMedia {forced-colors:active}` over CDP; chip background / border / icon-path diffed against the non-forced run |
| 8 | Fonts | `document.fonts.check()` × 3 families × 4 weights, network panel on cold load, `dist` inventory |
| 9 | Bundle | `dist` inventory + per-route cold-load `PerformanceResourceTiming` (`encodedBodySize` / `decodedBodySize`) with `Network.clearBrowserCache` between routes; package attribution from the shipped source maps |
| 10 | Console / network | `list_console_messages` + `list_network_requests` on every route after a full page load |

Widths were applied with `Emulation.setDeviceMetricsOverride` (exact viewport, `isMobile:false`,
`hasTouch:false`) to match the prior sweeps. Real touch emulation was not used — see §7.

---

## 2. Per-route results

### 2.1 Lighthouse (10 runs, all parsed from `report.json`)

| Route | Device | A11y | Best Practices | SEO | Agentic | Distinct failing audits |
|---|---|---|---|---|---|---|
| `/recommend` | desktop | **100** | 100 | 91 | 67 | `robots-txt`, `llms-txt` |
| `/recommend` | mobile | **100** | 100 | 91 | 66 | + `cumulative-layout-shift` (0.065) |
| `/explore` | desktop | **100** | 100 | 91 | 67 | `robots-txt`, `llms-txt` |
| `/explore` | mobile | **100** | 100 | 91 | 66 | + `cumulative-layout-shift` (0.041) |
| `/schedule` | desktop | **100** | 100 | 91 | 65 | + `cumulative-layout-shift` (0.068) |
| `/schedule` | mobile | **100** | 100 | 91 | 63 | + `cumulative-layout-shift` (0.102) |
| `/onboarding` | desktop | **100** | 100 | 91 | 67 | `robots-txt`, `llms-txt` |
| `/onboarding` | mobile | **100** | 100 | 91 | 63 | + `cumulative-layout-shift` (0.103) |
| `/data` | desktop | **95** | 100 | 91 | 33 | **`aria-allowed-attr`**, `agent-accessibility-tree`, `robots-txt`, `llms-txt` |
| `/data` | mobile | **95** | 100 | 91 | 30 | same + `cumulative-layout-shift` (0.101) |

Only **four** distinct failing audits exist across all ten runs:

- **`aria-allowed-attr` (`/data` only)** — `div[data-slot="meter"]` carries `aria-valuenow / valuemin / valuemax / valuetext` without exposing the `meter` role. This is HeroUI v3’s `Meter` internals; **pre-existing, matches the prior review exactly** (95 on `/data`, 100 elsewhere).
- **`robots-txt` / `llms-txt`** — the SPA fallback returns `index.html` for `/robots.txt`, so Lighthouse parses HTML as robots.txt. Non-a11y, out of scope for a local-first app, **pre-existing** (SEO 91 on every route including the ones untouched in shape).
- **`cumulative-layout-shift`** — see D9.
- **`agent-accessibility-tree` (`/data` only)** — downstream of the same `Meter` ARIA problem.

### 2.2 Responsive / contrast — all 48 combinations

Every cell below is `contrast failures / page-level horizontal scroll / genuine sub-44px targets`,
followed by the measured **minimum contrast ratio on the page** (the floor, not just the failures).

| Route | 375 light | 375 dark | 768 light | 768 dark | 1024 light | 1024 dark | 1440 light | 1440 dark |
|---|---|---|---|---|---|---|---|---|
| `/recommend` | 0/no/0 · 5.91 | 0/no/0 · 7.55 | 0/no/0 · 5.91 | 0/no/0 · 7.55 | 0/no/0 · 5.71 | 0/no/0 · 6.47 | 0/no/0 · 5.71 | 0/no/0 · 6.47 |
| `/explore` | 0/no/**1** · 5.29 | 0/no/**1** · 5.61 | 0/no/**1** · 5.29 | 0/no/**1** · 5.61 | 0/no/**1** · 5.91 | 0/no/**1** · 7.06 | 0/no/**1** · 5.91 | 0/no/**1** · 7.06 |
| `/schedule` | 0/no/0 · 5.71 | 0/no/0 · 6.39 | 0/no/0 · **4.98** | 0/no/0 · 5.93 | 0/no/0 · **4.98** | 0/no/0 · 5.93 | 0/no/0 · **4.98** | 0/no/0 · 5.93 |
| `/onboarding` | 0/no/0 · 5.91 | 0/no/0 · 7.06 | 0/no/0 · 5.91 | 0/no/0 · 7.06 | 0/no/0 · 5.91 | 0/no/0 · 7.06 | 0/no/0 · 5.91 | 0/no/0 · 7.06 |
| `/data` | 0/no/0 · 5.91 | 0/no/0 · 7.55 | 0/no/0 · 5.91 | 0/no/0 · 7.55 | 0/no/0 · 5.91 | 0/no/0 · 7.10 | 0/no/0 · 5.91 | 0/no/0 · 7.10 |
| 404 | 0/no/0 · 5.91 | 0/no/0 · 8.18 | 0/no/0 · 5.91 | 0/no/0 · 8.18 | 0/no/0 · 5.91 | 0/no/0 · 7.55 | 0/no/0 · 5.91 | 0/no/0 · 7.55 |

- **0 contrast failures in 48/48 combinations.**
- **0 page-level horizontal scroll in 48/48** (`documentElement.scrollWidth === clientWidth` everywhere).
- Global contrast floor: **4.98:1** (`/schedule`, light, the 13px `<small>` teacher name inside a class block) — above the 4.5 threshold. Light floor 4.98, dark floor 5.61.
- The single sub-44px target on `/explore` is defect **D1**.
- The mobile filter Drawer on `/recommend` at 375 was audited in its **open** state as well: 0 contrast failures, 0 real small targets, floor 6.47 dark / 5.71 light.
- `1024` and `1440` `/explore` additionally show 20 in-table course-name links at 24px height. That is desktop-only, meets WCAG 2.2 AA (24×24) exactly, and is outside the 375/768 touch requirement — recorded as informational, not a defect.
- Exactly **one `<h1>` per route**, on every route, at every width, including the 404.

Focus ring, measured by the same pixel method:

| theme | element | ratio vs surround |
|---|---|---|
| light | skip link | **7.77:1** |
| light | search input / theme toggle | 8.40:1 |
| dark | button on `/explore` | 8.50:1 |

Matches the previously reported 7.77 light figure exactly.

### 2.3 Console and network, per route (full page load)

| Route | console errors | console warnings | failed requests | API calls | fonts |
|---|---|---|---|---|---|
| `/recommend` | 0 | 0 | 0 / 25 | `facets` ×**1** | 3 |
| `/explore` | 0 | 0 | 0 / 27 | `facets` ×1, `courses` ×1 | 4 |
| `/schedule` | 0 | 0 | 0 / 19 | `courses/batch` ×1 | 3 |
| `/onboarding` | 0 | 0 | 0 / 22 | `departments`, `class-groups` | 4 |
| `/data` | 0 | 0 | 0 | — | — |
| 404 | 0 | 0 | 0 / 9 | — | 2 |

`facets` is requested **once** on `/recommend` — the T21 target is holding.
`/assistant` redirects to `/recommend` as designed.

The only non-empty console output is two Chrome **DevTools Issues** (not errors, not warnings) —
see D10.

---

## 3. Keyboard walkthrough

Driven entirely with real key events.

| Step | Result |
|---|---|
| Skip link reachable | ✅ 8 × `Shift+Tab` from the route-focused `<h1>` reaches it; it becomes visible on focus (128 × **48 px** at 16,16) with a 3px focus ring |
| Skip link activation | ⚠️ **`document.activeElement` becomes `<body>`** — see **D6**. Sequential focus does continue correctly into `<main>` (next `Tab` lands on the query textarea, `insideMain: true`), so it is functional |
| Route focus → `<h1>` | ✅ on initial load **and** on SPA route change (nav-link click → `/explore`, `activeElement` = `H1 "課程資料庫"`, exactly 1 `<h1>`) |
| Modal (plan rename) | ✅ opens with focus on the input; 4 × `Tab` cycles and stays inside; `Escape` closes; focus returns to the **重新命名** trigger; scroll lock released (`body overflow: visible`) |
| Drawer — course details (`placement="right"`) | ✅ focus moves inside, trap holds over 3 × `Tab`, `Escape` closes, focus returns **to the exact `.class-block` trigger element** |
| Drawer — mobile filters (`placement="bottom"`, 375) | ✅ has `drawer-handle`, 690 × 375, focus inside, `Escape` closes, focus returns to the 篩選 trigger (44 × 88 px) |
| Drawer — mobile nav (375) | ✅ trigger is exactly 44 × 44, `aria-expanded` toggles, all 5 links ≥ 50px tall, close button 44px, `Escape` returns focus to the trigger |
| ComboBox (`/onboarding` 主修系所) | ✅ `ArrowDown` opens (67 options, 6 `ListBox.Section` groups), `aria-activedescendant` advances (資訊工程學系 → 資訊管理學系), focus stays on the input, `Escape` closes and reverts the value |
| Timetable 2-D arrows | ✅ `ArrowRight` col 2→3, `ArrowDown` row 2→3. **Occupied cells are skipped**: from 星期二 E0 (row 12), one `ArrowDown` lands on 星期二 **E4** (row 16), stepping over the three cells occupied by 微積分 E1–E3 |
| Roving tabindex | ✅ **exactly one** `button.schedule-slot-button[tabindex="0"]` at all times, before and after every arrow move. ⚠️ The three `.class-block` buttons inside the grid are separately tabbable (`tabindex="0"` each), i.e. the grid has 4 tab stops rather than 1. Not a trap, but it is not the ARIA grid pattern — recorded as informational |
| Plan tablist | ✅ `ArrowRight` / `ArrowLeft` move selection with automatic activation; roving tabindex `["0","-1","-1","-1"]` follows correctly; `aria-selected` follows |
| Theme toggle | ✅ tab-reachable (first element reached by `Shift+Tab` from `<h1>`); `Enter` toggles; writes `data-theme` **only** (`documentElement.className` stays `""`); persists to `localStorage["fju-theme"]`; `aria-label` flips 切換為深色模式 ⇄ 切換為淺色模式; focus stays on the button |

**Nothing was unreachable.** The only focus that lands on `<body>` is the skip-link case (D6), which is pre-existing.

### No-flash-of-wrong-theme

Verified structurally and empirically:

- `dist/index.html`: the blocking classic inline script is at **line 23–37**; the render-blocking
  `<link rel="stylesheet">` is at **line 44**. The parser therefore rewrites `data-theme` before
  the stylesheet is even requested, so no styled frame can precede it.
- Empirically: toggle to dark → reload → `documentElement.dataset.theme === "fju-dark"` and
  `html` background `oklch(0.1768 0.007 258.37)` on the first script-observable moment; the choice
  survived every reload during the sweep.
- I could **not** capture the literal first painted frame — the MCP `navigate_page` `initScript`
  parameter had no effect in this MCP build, so a document-start probe could not be installed.
  The ordering argument above is structural, not a frame capture.

---

## 4. Reduced motion (CDP `Emulation.setEmulatedMedia`)

| Signal | motion allowed | `prefers-reduced-motion: reduce` |
|---|---|---|
| `matchMedia('(prefers-reduced-motion: reduce)')` | `false` | `true` |
| `document.getAnimations()` running, peak over 2.5 s on `/explore` | **72** | **0** |
| `NumberTicker` (`/explore` total) distinct intermediate values | **27** (`0` → `826` → `1,363` → … → `4,233`) | **1** — renders `4,233 門結果` immediately, and the `aria-hidden` animated span is not mounted at all |
| `document.startViewTransition` calls on theme toggle | **1** | **0** |
| `Element.animate` calls on theme toggle | **1** | **0** |
| theme still changes | ✅ | ✅ |

`NumberTicker` settles instantly and `ThemeToggle` skips `startViewTransition` — both confirmed by
measurement, not by reading the source.

**`BlurFade` could not be exercised in the browser.** It has exactly one call site
(`RecommendPage.tsx:301`, the results grid), and no recommendation results can be produced locally:
submitting a query returns the correct error Alert **“推薦失敗 / Embedding model unavailable / 重試”**
because `sentence_transformers` is not installed. The reduced-motion bypass is covered by
`components/motion/motion.test.tsx` and uses the *same* `useReducedMotion` gate that I measured
working on both `NumberTicker` and `ThemeToggle`, but I did not observe it in a browser.

---

## 5. Print — `/schedule` at A4 landscape

Measured twice: with explicit A4 landscape paper, and with `preferCSSPageSize:true` so the app’s own
`@page{size:A4 landscape;margin:10mm}` drove layout. **Identical findings both ways.**

**Requirement met — all seven day columns render unclipped.**
Column edges under print media, page width 1123 px:

`節次` 8–80 · 星期一 80–227.8 · 星期二 227.8–375.7 · 星期三 375.7–523.6 · 星期四 523.6–671.4 ·
星期五 671.4–819.3 · 星期六 819.3–967.1 · 星期日 967.1–**1115** — inside the 1123 px page.

Chrome hidden: `header.topbar` `display:none` ✅, `footer` `display:none` ✅, plan tablist, toolbars,
slot buttons, mobile list, dialogs and toast region all in the hide-list ✅.

Three print defects — **D2, D3, D4** below.

---

## 6. forced-colors, fonts, bundle

### forced-colors: active

The eligibility signal **stays distinguishable when backgrounds are flattened.** All four states
were compared with and without emulation:

| state | normal background | forced background | forced border | icon path length (distinct shape) |
|---|---|---|---|---|
| `資格符合` | `oklab(0.5141 −0.1039 0.0457 / .15)` | `rgba(255,255,255,.15)` | **`1px solid rgb(0,0,0)`** (CanvasText) | 168 |
| `未見限制` | `oklab(0.9615 … / .5)` | `rgba(255,255,255,.5)` | **`1px solid rgb(0,0,0)`** | 182 |
| `資格待確認` | `oklab(0.547 0.0411 0.1114 / .15)` | `rgba(255,255,255,.15)` | **`1px solid rgb(0,0,0)`** | 287 |
| `資格不符` | `oklab(0.5013 0.1564 0.0856 / .15)` | `rgba(255,255,255,.15)` | **`1px solid rgb(0,0,0)`** | 258 |

Without forced colours the chips have `border-width: 0`; under forced colours T41b’s rule supplies a
1px `CanvasText` border, so each chip is still delimited. Colour is gone, but **the icon shape and
the text label both differ per state** (four distinct SVG paths, four distinct labels), so the triple
channel degrades to a double channel rather than to nothing. ✅

### Fonts

| check | result |
|---|---|
| `@font-face` declared in the built CSS | **12** (3 families × 4 weights) |
| `unicode-range` occurrences in the built CSS | **0** — the T41b three-tier decision shipped |
| `@font-face` bytes as a share of the 306.7 kB CSS | 1,800 B = **0.6%** (was ~330 kB of hex ranges) |
| `document.fonts.check()` on `/explore` as loaded | **4 / 12 true** — `FJU Sans 1` 400/500/600/700 |
| after `document.fonts.load()` is forced for the rest | **12 / 12 true** — tiers 2 and 3 resolve correctly; they are simply lazy, which is the intended behaviour of a family fallback chain |
| font requests on cold load | **4** on `/recommend`/`/schedule` (tier 1 400/500/700 + 600 where used), **4–5** on `/explore` (one page needed `fju-sans-2-700` for a rarer codepoint), **2** on the 404. **Not 42.** |
| `dist/assets/OFL.txt` | **ships**, 4,314 B, served **200** |
| computed `body` stack | `"FJU Sans 1","FJU Sans 2","FJU Sans 3","Noto Sans TC","PingFang TC",…` — Inter is gone, as decided |

### Bundle vs plan §3.1 baseline

Baseline: **316.94 kB JS / 103.66 kB gzip, 43.51 kB CSS / 9.35 kB gzip, one chunk, no splitting.**

| metric | baseline | now | Δ |
|---|---|---|---|
| JS chunks | **1** | **27** | code splitting delivered |
| JS total raw (all chunks) | 316.94 kB | **1,143.69 kB** | ×3.61 |
| JS total gzip (all chunks) | 103.66 kB | **365.51 kB** | ×3.53 |
| CSS raw | 43.51 kB | **306.71 kB** | ×7.05 |
| CSS gzip on the wire (server `GZipMiddleware`) | 9.35 kB | **38,157 B = 37.26 kB** | ×3.99 |
| `dist` without maps | (2.2 MB / 27 files, per T12) | **8.70 MB / 42 files** (12 woff2 = 7.67 MB) | fonts are now self-hosted |

**Per-route cold load** (`Network.clearBrowserCache` between routes; `encodedBodySize` = on the wire):

| route | JS files | JS wire | JS raw | CSS wire | font files | font wire | total wire |
|---|---|---|---|---|---|---|---|
| `/recommend` | 18 | **272.5 kB** | 843.4 kB | 38.2 kB | 3 | 864.9 kB | 1,190.4 kB |
| `/explore` | 19 | **283.9 kB** | 891.2 kB | 38.2 kB | 4 | 1,154.5 kB | 1,522.5 kB |
| `/schedule` | 12 | **222.0 kB** | 694.2 kB | 38.2 kB | 3 | 864.9 kB | 1,134.3 kB |
| `/onboarding` | 14 | **221.8 kB** | 693.1 kB | 38.2 kB | 4 | 1,154.5 kB | 1,435.0 kB |
| `/data` | 12 | **182.8 kB** | 561.4 kB | 38.2 kB | 4 | 1,154.5 kB | 1,382.0 kB |
| 404 | 3 | **150.4 kB** | 478.3 kB | 38.2 kB | 2 | 576.4 kB | 768.2 kB |

So the honest headline is: **the worst single route now ships 283.9 kB of gzipped JS where the old
app shipped 103.66 kB for everything — ×2.74 on the wire for the heaviest route**, and ×3.53 if you
count every chunk in `dist`. Code splitting means no user downloads all 27 chunks on one visit,
but it does not make the increase small.

**Where it went.** Attribution from the shipped source maps (pre-minification source bytes, 3.98 MB
mapped total):

| package group | bytes | share |
|---|---|---|
| **HeroUI + React Aria stack** (`react-aria` 1,050,748 · `react-aria-components` 401,010 · `@heroui/react` 225,552 · `react-stately` 163,122 · `tailwind-variants` 140,391 · `@heroui/styles` 28,737 · `@internationalized/*` 14,383) | **2,023,943** | **50.8%** |
| `react-dom` + `react` + `scheduler` | 574,467 | 14.4% |
| **motion** (`motion-dom` 350,124 · `framer-motion` 113,677 · `motion-utils` 10,855 · `motion` 717) | 475,373 | 11.9% |
| `react-router` | 347,249 | 8.7% |
| **app source** | 409,421 | **10.3%** |
| `@tanstack/query-*` | 81,948 | 2.1% |
| `@phosphor-icons/react` | 66,345 | 1.7% |

CSS, by layer in the built file:

| layer | bytes | share | what it is |
|---|---|---|---|
| `@layer components` | **209,544** | **68.3%** | 57 selective HeroUI component imports. Pure BEM — Tailwind cannot tree-shake it. This is the whole CSS story. |
| `@layer theme` | 29,144 | 9.5% | design tokens (HeroUI defaults + `theme/fju.css`) |
| `@layer base` | 27,867 | 9.1% | Tailwind preflight + HeroUI base + scrollbar |
| `@layer utilities` | 6,011 | 2.0% | actually-used Tailwind utilities — tree-shaking *is* working |
| `@layer properties` | 2,369 | 0.8% | `@property` registrations |
| `@font-face` × 12 | 1,800 | 0.6% | the T41b subsetting win |

**Verdict on the increase**: it is real, it is explained, and every kilobyte of it is a deliberate
plan decision (React 19 + HeroUI v3/React Aria + TanStack Query + `motion`). Roughly **half the JS
and two thirds of the CSS is HeroUI/React Aria**. The plan asked for these libraries by name, so
this is the price of the plan, not a regression against it — but it should be stated in those terms
rather than hidden behind “code splitting means it’s fine”.

---

## 7. What could not be tested, and why

| Item | Reason |
|---|---|
| **Semantic recommendation results** — result cards, the `BlurFade` stagger, the result grid at four widths, the 2-column cap, the ≤1-screen-scroll mobile target | `sentence_transformers` is not installed; `/health/ready` returns 503 and a query returns `Embedding model unavailable`. `/explore` (real catalogue, 4,233 courses) was used for all card-level checks instead. |
| **`BlurFade` in a real browser, in either motion mode** | Same cause — it has exactly one call site, in the results grid. Covered by unit test; shares the `useReducedMotion` gate I did measure on the other two consumers. |
| **The literal first painted frame after reload** (flash of wrong theme) | The MCP `navigate_page` `initScript` parameter had no effect in this build, so no document-start probe could be installed. Argued structurally from the built `index.html` ordering (inline script line 23, stylesheet line 44) plus post-load state. |
| **Real Windows High Contrast** | Chrome `forced-colors: active` emulation only. |
| **Real touch input / coarse pointer** | Widths were applied with `isMobile:false, hasTouch:false` to match the prior sweeps, so any CSS keyed on `pointer:coarse` or `hover:none` was not exercised. |
| **`docker compose build`** | Explicitly out of my remit; run and verified by the orchestrator. |
| **`pnpm test` / `npx tsc -b`** | Already run by the requester (268 tests / 28 files; 0 type errors). I re-ran `pnpm build` only (exit 0). |
| **`/assistant` page UI** | Redirects by design (`AI_ASSISTANT_VISIBLE === false`); left hidden, as instructed. Its CSS still lives in `styles.css`. |

---

## 8. Defects

Severity: **S2** = should fix before calling this done · **S3** = fix soon, does not block ·
**S4** = informational / accept.

### D1 · S2 · `/explore` search field is a 36 px touch target — *introduced*
**Route/state**: `/explore`, all four widths, both themes.
**Measured**: `input.search-field__input` has `min-h-11` and a raw rect of **278 × 44**, but its
parent `.search-field__group` is **36 px** tall with `overflow: hidden`. Hit-testing is clipped to
the parent: `elementFromPoint` at the input’s own top edge returns `DIV.search-field`, at the
group’s mid-point returns the input, at the input’s bottom edge returns `DIV.mb-6`. Effective
target = **278 × 36**. When the field has text, the clear button is likewise **44 × 36**.
**Expected**: ≥ 44 × 44 at 375 and 768 (plan §5, and the app’s own `min-h-11` intent).
**Also visible**: the field is noticeably shallower than the two adjacent `Select`s (44 px) in every
screenshot, at mobile and desktop alike.
**Cause**: the unified 44px repair (FIX50 / T41b) targets the inner control; the HeroUI
`search-field__group` wrapper keeps its own 36 px height and clips.
**Note**: this is the only genuine sub-44px target found in the entire 48-combination sweep.

### D2 · S2 · The skip link prints on every page — *introduced*
**Route/state**: `/schedule` print, A4 landscape (reproduced both with explicit paper settings and
with the app’s own `@page{size:A4 landscape;margin:10mm}`).
**Measured**: `.skip-link` is `position: fixed`, `transform: translateY(-86.4px)`, rect
`y = -70.4`, `visibility: visible`, `display: block`, no clip. Off-canvas on screen (confirmed by
viewport screenshot), but Chrome’s print engine repeats fixed elements inside each page box, so
**“跳到主要內容” is painted on page 1 (overlapping the DN row of the timetable) and again on page 2.**
**Expected**: hidden in print, like the rest of the chrome.
**Cause**: the `@media print` hide-list covers `.topbar`, `footer`, toolbars, tablist, dialogs and
the toast region, but not `.skip-link`.

### D3 · S3 · Print emits 3 pages for a 2-page timetable, and slices a row — *introduced*
**Measured**: `document.scrollHeight` 1,314 px under print media at 1123 × 794. The PDF has
**3 `/Type /Page` objects**; page 3 contains only an empty background block. The **DN row is cut
mid-height** across the page-1 / page-2 boundary (D0–DN on page 1, D5–E4 on page 2).
**Expected**: 2 pages, and no row split (no `break-inside: avoid` on `.schedule-row`).

### D4 · S3 · The route-focus outline on `<h1>` is printed — *introduced*
**Measured**: under print media, `h1` is still `document.activeElement` (`tabindex="-1"`, focused by
`RouteFocusManager`) and `outline: oklch(0.4231 0.1136 254.59) solid 3px` still applies. The PDF
shows a 3 px box around **我的課表**. Cosmetic; visible on every printed schedule.

### D5 · S3 · `role="grid"` has no accessible name — *introduced*
**Measured**: `.schedule-grid[role="grid"]` has `aria-rowcount="16"`, `aria-colcount="8"` (T35
delivered those) but **`aria-label: null` and `aria-labelledby: null`**. Both `role="toolbar"`
elements (`課表方案操作`, `課表顯示設定`) and the `role="tablist"` (`課表方案`) *do* carry names, so
this is an inconsistency rather than a policy. axe/Lighthouse do not flag it (a11y is 100 on
`/schedule`), but a screen reader announces an unnamed grid.

### D6 · S3 · Skip link leaves focus on `<body>` — **pre-existing**
**Measured**: `Enter` on the skip link navigates to `#main-content`, scroll moves, but
`document.activeElement === <body>`. `<main id="main-content">` has **no `tabindex="-1"`**.
The next `Tab` does land inside `<main>` (Chrome’s sequential-focus starting point), so the link is
functional; what is missing is moving focus and screen-reader context onto the landmark.
**Pre-existing**: `git show main:frontend/src/App.tsx:212` is `<main id="main-content">` with no
`tabIndex` either. The refactor neither introduced nor fixed it.

### D7 · S3 · Untranslated English accessible names from HeroUI defaults — *introduced*
**Measured**, in a `zh-Hant` app:
- `/explore`: `nav[aria-label="pagination"]` (the pagination landmark). The pagination *buttons*
  are correctly localised — `aria-label="上一頁"` etc.
- `/explore`, only when the search field has text: the clear button is `aria-label="Close"`.

No other Latin-only `aria-label` / `title` / `placeholder` exists on any of the five routes.

### D8 · S4 · Lighthouse a11y 95 on `/data` — **pre-existing, library-owned**
`aria-allowed-attr`: `div[data-slot="meter"]` carries `aria-valuenow="0.0214…"`, `aria-valuemin="0"`,
`aria-valuemax="100"`, `aria-valuetext="0%"` without exposing the `meter` role. HeroUI v3 `Meter`
internals; identical to the state recorded in the previous review. Also drags the (non-a11y)
`agent-accessibility-tree` audit to 0 on `/data`.

### D9 · S4 · Mobile CLS just over the “good” threshold — *introduced*
`/onboarding` **0.103**, `/schedule` **0.102**, `/data` **0.101** on Lighthouse mobile — in the
0.1–0.25 “needs improvement” band. Desktop is clean everywhere (0.010–0.068), as is mobile
`/explore` (0.041) and `/recommend` (0.065).

### D10 · S4 · Chrome DevTools form-field issues — library, not an a11y failure
“No label associated with a form field” (×3 on `/recommend`, ×1 on `/onboarding`) and “A form field
element should have an id or name attribute” (×3 on `/recommend`, ×2 on `/schedule`). All of them are
HeroUI `Switch` / `Checkbox` / `Radio` visually-hidden inputs that carry **no `id` and no `name`**.
They are wrapped in a `<label>`, so the accessible name is correct and axe/Lighthouse pass (100 on
both routes). This is Chrome’s autofill heuristic, not WCAG.

### D11 · S3 · `styles.css` is 555 code lines against a plan target of ≤120 — *plan target missed*
**Measured**: 1,343 raw lines / 101,202 B, of which 50,059 B is comment. Non-comment, non-blank:
**555 lines** = 57 `@import`/`@layer`/`@custom-variant` directives + **498 hand-written rule lines**.
Plan §T41 says “壓到 ≤120 行”. Even excluding the 57 HeroUI selective-import lines (which the 120
figure plainly did not anticipate), it is **4.2× the target**. The content is legitimate — schedule
grid, class blocks, six `@media print` blocks, `forced-colors`, reduced-motion, breakpoint layout,
the unified control repair, plus the still-present AssistantPage styles for a hidden route — but the
number is what it is.

### Informational (no action implied)
- `/explore` desktop table: 20 course-name links at **24 px** height. Desktop only; meets WCAG 2.2
  AA target size (24 × 24) exactly; outside the 375/768 requirement.
- `.eyebrow` on `/data` renders at **12.48 px** — below the 16 px mobile body-text guideline, though
  it is an eyebrow label rather than body text. Contrast at that size is 5.91:1, so it passes.
- The 404 route returns **HTTP 200** (SPA fallback) while rendering 找不到這個頁面. Standard SPA
  trade-off; the page itself is correct (1 `<h1>`, 0 contrast failures, floor 5.91/8.18).
- The schedule grid has **4 tab stops** (1 roving slot button + 3 `.class-block` buttons) rather than
  the single tab stop of the strict ARIA grid pattern. Not a trap; arguably more usable.
- `NumberTicker` correctly pairs an `aria-hidden` animated span with an `sr-only` true value, so a
  screen reader never reads a mid-animation number.

---

## 9. Verdict against the plan’s four quality bars

| Bar | Verdict | Evidence |
|---|---|---|
| **Tests green** | ✅ **Pass** (not re-run by me) | 268 tests / 28 files reported green by the requester. I re-ran `pnpm build` only: exit 0, 27 JS chunks + 1 CSS + 12 woff2. |
| **Types and build pass** | ✅ **Pass** | `npx tsc -b` 0 errors (requester). `pnpm build` re-run by me, exit 0, and the served bundle byte-matches the artefact. |
| **Accessibility must not regress** | ✅ **Pass — and materially improved** | 48/48 route × theme × width combinations: **0 contrast failures**, floor **4.98:1**. 0 page-level horizontal scroll in 48/48. Lighthouse a11y **100 on 4 of 5 routes × both form factors**; the single 95 is the pre-existing HeroUI `Meter` bug. Full keyboard walkthrough passes: focus trap, `Escape`, return-focus on Modal and on all three Drawers; ComboBox; 2-D grid navigation that skips occupied cells with exactly one roving `tabindex=0`; plan tablist; theme toggle. Focus ring 7.77:1 light / 8.50:1 dark. `forced-colors` keeps the eligibility signal via border + distinct icon + distinct label. Reduced motion: 72 → **0** running animations, ticker settles instantly, `startViewTransition` skipped. The refactor **introduces one genuine a11y-adjacent defect (D1, a 36 px target)** and three print defects; against that it fixes the entire pre-refactor dark-mode contrast failure set. |
| **Commits independently mergeable** | ✅ **Pass** | 43 commits ahead of `main`: 31 work commits + 12 worktree merge commits, one per task/fix, each with a scoped conventional-commit subject. Working tree clean apart from one untracked orchestrator note (`.whl/subagent/42-final-verification.md`). No conflicts pending. |

### Should any defect block calling this refactor done?

Ranked:

1. **D1 (36 px search field, `/explore`)** — the only thing I would ask to be fixed before shipping.
   It is a one-line height/overflow fix, it is the sole 44px violation in a 48-combination sweep,
   it is visible as a design inconsistency at every width, and it silently defeats a repair the
   refactor deliberately made.
2. **D2 (skip link printed over the timetable)** — the second-most-worth-fixing, and also one line
   (add `.skip-link` to the existing print hide-list). Print is a named, user-facing feature of
   `/schedule` (there is a 列印／另存 PDF button), and the artefact lands on top of the grid.
3. **D3 / D4 (extra blank print page, sliced DN row, printed focus outline)** — same file, same
   sitting, but genuinely cosmetic. Fix with D2 or accept.
4. **D5 (unnamed `role="grid"`), D7 (two English HeroUI labels), D11 (`styles.css` 555 lines vs 120)**
   — real, small, non-blocking. D11 is a plan-target miss to acknowledge rather than a defect to fix.
5. **D6 (skip link → `<body>`), D8 (HeroUI `Meter`), D9 (mobile CLS ~0.10), D10 (autofill issues)**
   — accept. D6 and D8 are pre-existing; D9 and D10 are marginal or library-owned.

**Overall**: the refactor meets all four quality bars. Nothing found is a correctness or
accessibility regression against the pre-refactor app. D1 and D2 are the two I would fix first;
everything else is safely deferrable. The one thing that deserves to be said plainly rather than
buried is the bundle: **the heaviest route now ships 2.74× the gzipped JS of the entire old app**,
and about half of that is HeroUI/React Aria — a cost the plan asked for, but a cost.

---

## Post-report fixes (orchestrator, `7156677`)

The two S2 defects this report identified as **introduced by the refactor** were
fixed and verified before the refactor was called done:

1. **`/explore` search field 36px touch target** — `SearchField.Input` carried
   `min-h-11`, but HeroUI's `.search-field__group` is 36px with
   `overflow:hidden`, clipping it back down. Raised the group. Re-measured in
   Chrome: group 44px, input 44px, `elementFromPoint` at both vertical extremes
   lands on the input, matching the 44px Selects beside it.
2. **Skip link printed on every sheet**, landing on the timetable's DN row.
   Added to the print hide-list together with the `h1` focus ring the route
   focus manager leaves behind. Verified both rules survive the build and
   lightningcss minification inside a real `@media print` block.

`pnpm test` 268/28 green · `npx tsc -b` 0 · `pnpm build` ok after the fix.

## Docker verification (orchestrator, not the reviewer)

`docker compose build` — exit 0. The image was then **run and exercised**, not
just built:

| check | result |
|---|---|
| `dist` in image | **8.9 MB / 42 files** (was 11.8 MB / 431) |
| woff2 / `@font-face` / `unicode-range` | 12 / 12 / **0** |
| sourcemaps in image | **0** |
| `assets/OFL.txt` | present, served 200 — OFL clause 2 gap closed |
| container `/health/ready` | **200** |
| six routes + unknown path (SPA fallback) | all **200** |
| `/api/v1/facets` | **200** |
| CSS on the wire, real backend + GZipMiddleware | **38,226 B** (was ~242 kB) |

The last row is the headline user-facing result of the refactor, measured from a
real container rather than inferred from build output.
