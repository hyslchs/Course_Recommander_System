# 任務分解 — 前端整體重構

計畫文件：`.whl/plan/frontend-refactor.md`
狀態圖例：`pending` / `in_progress` / `done` / `blocked`

**每個任務的通用驗收（不再逐項重複）**
```bash
cd frontend && pnpm test && npx tsc -b && pnpm build
```
全綠 + 無障礙不退步 + commit 可獨立合併。
**UI 任務另須**：375 / 768 / 1024 / 1440 四寬度 × 亮暗兩色實測（chrome-devtools MCP `resize_page` + `emulate` + `take_snapshot`）。

---

## 階段 0 — 地基與去風險（必須最先，且 T00→T01 有嚴格順序）

### `00-config-cruft-fix`
**Status**: done ✅ · **Depends**: —

修掉會讓後續所有 config 變更失效的阻塞問題。

- `tsconfig.node.json` 加 `"noEmit": true`（TS 5.x 起 composite + noEmit 合法）
- `git rm --cached frontend/vite.config.js frontend/vite.config.d.ts`，實體刪除，加進 `.gitignore`
- 釘死 Node：`Dockerfile:1` `node:22-alpine` → `node:24.15-alpine`；`.github/workflows/ci.yml:18` `node-version: 22` → `24.15`
- `package.json`：`typescript` / `vite` / `@vitejs/plugin-react` 從 `dependencies` 移到 `devDependencies`
- ~~`frontend/pnpm-workspace.yaml`：刪掉無效的 `allowBuilds:` 區塊~~ → **此項作廢，檔案維持 HEAD 原樣（兩個鍵都保留）**。實測：`allowBuilds` 才是 pnpm 11 的現行設定，`onlyBuiltDependencies` 已於 pnpm 11 移除；本機 pnpm 11.9.0 刪掉 `allowBuilds` 會直接 `ERR_PNPM_IGNORED_BUILDS`。CI 釘 pnpm 10 仍需 `onlyBuiltDependencies`。詳見 T11。
- 評估 `build.sourcemap`：`true` → `"hidden"` 或 `false`（現在 1.22MB map 被公開 serve）

**檔案**：`frontend/tsconfig.node.json`, `frontend/vite.config.ts`, `frontend/package.json`, `frontend/pnpm-workspace.yaml`, `.gitignore`, `Dockerfile`, `.github/workflows/ci.yml`
**驗證**：改 `vite.config.ts` 加一個 console log，跑 `pnpm dev` 確認**這次真的生效**；`tsc -b --listEmittedFiles` 不再吐出 `vite.config.js`

---

### `01-detest-classnames`
**Status**: done ✅ · **Depends**: `00-config-cruft-fix`

**在動任何 production 程式碼之前**，把 8 個綁死 CSS class 的 DOM 測試改寫成 role / accessible-name 查詢。**這個 commit 不改任何 production 檔案**，測試必須在改寫前後都綠。

`ScheduleWorkspace.test.tsx`（6 個測試）現在用 `container.querySelector` 抓：
`.schedule-grid` · `.class-block` · `.class-block[aria-label^="日間課程"]` · `a.schedule-outline-link` · `.dialog-close` · `.segmented-control button` · `.schedule-hidden-notice` · `.slot-recommendation-dialog[role="dialog"]` · `.slot-category-filter` · `.slot-category-filter.home_elective` · `.slot-recommendation-actions button`（靠 DOM 順序取第一個 button）

改成 `getByRole` / `getByLabelText` / `findByRole` + accessible name。同時把 `createRoot`+`act` 換成 `@testing-library/react`（`ui.test.tsx` 已是這個寫法，是好範本）。
**保留**「不掛任何 provider 也能渲染」這個既有特性 —— 它是刻意的。

`ui.test.tsx`（2 個測試）已經是 role-based，**不用動**，但確認它在 T10 升級後仍綠。

**檔案**：`frontend/src/ScheduleWorkspace.test.tsx`
**驗證**：100 個測試全綠，且 `git diff --stat` 只碰測試檔

---

### `02-extract-inline-logic`
**Status**: done ✅ · **Depends**: `00-config-cruft-fix`（可與 T01 併行）

把藏在 UI 檔裡的純邏輯搬進領域模組並補測試。**不改行為、不改 UI。**

從 `App.tsx` 搬出：
- `getHighCreditOptions` / `isHighCreditFilterSelected` / `toggleHighCreditFilter` / `formatCreditFilterSummary`（:62-86，四個純函式，**目前零測試**）+ `HIGH_CREDIT_THRESHOLD`
- `ACTIVE_SCHEDULE_PREFERENCE_ID` + `ActiveSchedulePreference`（:58, :116）—— persistence key 不該住在元件檔
- `statusLabels`（:99）與 `ScheduleWorkspace.tsx:169` 的 `eligibilityLabel` 是**同一個 enum 的兩套衝突文案**，合併成一份
- `weekdays`（:57）與 `ScheduleWorkspace.tsx:21` **逐字重複**，合併

從 `ScheduleWorkspace.tsx` 搬出：
- `formatMeetings`（:30）→ `domain/schedule.ts`（純函式、已被 `App.tsx:38` 反向 import、已有測試）
- `parseManualSections`（:41，正則解析，**目前零測試**）
- `weekPatternLabel`（:24）· `unplacedBlock`（:245，在 UI 檔裡建構領域型別）

**順手清掉**：未使用的 import `Warning`（`App.tsx:3`）與 `getRecord`（:10）；`validationSummaryRef`（:589）掛了但從未 focus；`setCompletionAnnouncement`（:792）從未被呼叫 → `:892` 的 aria-live 區永遠是空的（**修好它，不是刪掉它** —— 那是無障礙功能）

**檔案**：`frontend/src/App.tsx`, `ScheduleWorkspace.tsx`, `domain/*`（此時仍在 `src/` 平鋪，T20 才搬目錄）
**驗證**：新增的純函式測試涵蓋上述每一個；總測試數 >100

---

### `03-dead-code-purge`
**Status**: done ✅ · **Depends**: `01-detest-classnames`

- 刪掉 17 個完全未使用的 CSS class（約 3.5KB）：`.chip` `.category-filter` `.category-options` `.filter-option` `.priority-legend` `.recommendation-preferences` `.safety-filter-summary` `.filter-language-notice` `.detected-filter-list` `.detected-filter-text` `.query-understanding` `.understanding-chips` `.understanding-meta` `.query-chip`(+`.goal`/`.context`/`.exclusion`) `.error-banner` `.status-banner` `.schedule-dialog-backdrop` `.schedule-dialog-heading`
  ⚠️ `.schedule-dialog-backdrop` 仍在 `styles.css:65` 的 `@media print` hide-list 裡，**刪 class 時要同步清該選擇器清單**
- 修掉 4 個「有套用但從未定義」的 class：**`.secondary`（套在所有取消按鈕上 —— `ui.tsx:212`, `ScheduleWorkspace.tsx:527`, `App.tsx:1175`，這是真 bug）**、`.toast-success`、`.occupied`、`.recommendation-reasons`
- 修 `var(--card)`（`styles.css:3`）未定義
- **刪掉 `src/fju_outline/web_assets/`**（兩代前的舊前端，`app.js` / `index.html` / `styles.css`）
- **同步改 `src/fju_outline/web.py:644`**：`else: static_dir = LEGACY_STATIC_DIR` 改成**明確拋錯**。並移除 `:648-650` 的 `/static` mount。
  理由：現在本地忘記 `pnpm build` 時會靜默 serve 舊 UI，讓重構「看起來沒效果」

⚠️ **不要格式化 `styles.css`** —— 它是壓縮原始碼（第 1 行 7543 字元），且 ~15 個 selector 被定義 4–7 次靠行內順序決勝負。只做刪除。

**檔案**：`frontend/src/styles.css`, `src/fju_outline/web_assets/`（刪）, `src/fju_outline/web.py`
**驗證**：`pytest -q` 仍綠（後端測試）；`pnpm build` 後起服務確認前端正常；手動確認取消按鈕現在有 secondary 樣式

---

## 階段 1 — 套件升級與設計系統地基

### `10-upgrade-stack-atomic`
**Status**: done ✅ · **Depends**: `01-detest-classnames`, `02-extract-inline-logic`, `03-dead-code-purge`

**一次升五個套件，因為 peer dependency 讓它們無法拆開**（見計畫 §3.3）。**這個 commit 只升級，不改任何 UI。**

```bash
pnpm add react@^19.2.8 react-dom@^19.2.8 react-router@^8.3.0
pnpm remove react-router-dom
pnpm add -D @types/react@^19.2.18 @types/react-dom@^19.2.4 \
            vite@^8.2.2 @vitejs/plugin-react@^6.1.0 \
            vitest@^4.1.11 jsdom@^30.0.1
npx types-react-codemod@latest preset-19 ./src
```

必查項目：
- **ref callback 不可有隱式回傳值** —— grep arrow-body ref callback（`ref={c => (x = c)}` → `ref={c => { x = c }}`）。`ScheduleWorkspace.tsx:511` 的 `slotButtonRefs` callback ref 是首要嫌疑
- `useRef()` 現在**必須帶參數** → `useRef(undefined)`
- react-router import：`react-router-dom` → `react-router`（只有 `main.tsx:3` 與 `App.tsx:2` 兩行）
- **Vitest 4：`exclude` 預設只剩 `node_modules`/`.git`** → 設 `test.dir: "src"`，否則 build 後 `dist/` 會被掃進測試
- **Vitest 4：`globals: true`** —— 沒設的話 testing-library 的 auto-cleanup 不會跑（現在就沒設，順便確認測試有無 DOM 洩漏）
  ⚠️ **T01 實測補充**：`ScheduleWorkspace.test.tsx` 現在有**明確的 `afterEach(cleanup)`**（T01 加的，因為 auto-cleanup 沒註冊）。開 `globals: true` 後 auto-cleanup 會生效，**明確 cleanup 變成重複呼叫**（RTL 的 `cleanup` 是冪等的，不會壞，但要確認並考慮移除）。另：`ui.test.tsx` **沒有**明確 cleanup，目前只是靠兩個測試剛好不互相污染而過關 —— 開 `globals: true` 正好修掉這個潛在雷。
- **Vitest 3 的 `mockReset` 語義改變**（改成還原原始實作）—— `ScheduleWorkspace.test.tsx` 有 `vi.mock`，逐一確認
- `vitest.config.ts` 加上 `@vitejs/plugin-react`（現在完全沒有）
- **`vitest.config.ts` 本身沒被任何 tsconfig 型檢**，順手加進 `tsconfig.node.json` 的 include
- Vite 8：`build.outDir` / `sourcemap` / `server.proxy` 都不受影響，config 本身免改。但注意 CJS interop 與預設 target 提高（Chrome 111 / Safari 16.4）
- commit 重生的 `pnpm-lock.yaml`（CI 用 `--frozen-lockfile`）

**檔案**：`frontend/package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.node.json`, `src/main.tsx`, `src/App.tsx`
**驗證**：100+ 測試全綠 · `tsc -b` 0 錯 · `pnpm build` 成功 · **`pnpm dev` 手動開一遍五個頁面**（type check 抓不到 runtime ref 問題）

---

### `11-tailwind-heroui-tokens`
**Status**: done ✅ · **Depends**: `10-upgrade-stack-atomic`

導入 Tailwind v4 + HeroUI v3 + 設計 token。**視覺刻意不變** —— 舊 CSS 仍然勝出，這個 commit 只鋪地基。

```bash
pnpm add tailwindcss@^4.3.3 @heroui/styles @heroui/react
pnpm add -D @tailwindcss/vite@^4.3.3
```

- `vite.config.ts` 加 `tailwindcss()` plugin（**用 `@tailwindcss/vite`，不用 postcss** —— 本專案根本沒有 postcss pipeline）
- **`pnpm-workspace.yaml` 要把 `@tailwindcss/oxide` 同時加進 `allowBuilds` 與 `onlyBuiltDependencies` 兩個鍵**（有原生 postinstall，預設被封鎖，不加會讓 CI 與 Docker build 掛掉）
  ⚠️ **T00 實測更正**：計畫原本說 `allowBuilds` 是無效區塊 —— **錯的**。pnpm 官方文件：`onlyBuiltDependencies` 在 **pnpm 11 已移除**，由 `allowBuilds`取代。本機是 pnpm 11.9.0（刪掉 `allowBuilds` 會 `ERR_PNPM_IGNORED_BUILDS` 直接爆），CI 的 `pnpm/action-setup@v4` 釘 `version: 10`（只認 `onlyBuiltDependencies`），Dockerfile 是裸 `corepack enable` 未釘版本。**兩個鍵都留著是唯一同時對三個環境有效的寫法。**
- `src/styles.css` 開頭（**順序是 load-bearing，HeroUI 文件用 warning callout 標註**）：
  ```css
  @layer theme, base, components, utilities;
  @import "tailwindcss";
  @import "@heroui/styles";
  @import "./theme/fju.css" layer(theme);
  ```
- 新建 `src/theme/fju.css` —— 計畫 §4.2 的完整亮暗 token 組（oklch），含 `--info` 的 `@theme inline` 橋接（HeroUI 沒有這個預設 token）
- 新建 `src/theme/typography.css` —— 計畫 §4.4 的字體堆疊與級距；**自行 host Noto Sans TC 的 unicode-range 子集 woff2**（local-first 應用不該依賴 Google Fonts CDN），`font-display: swap`
- `<html data-theme="fju">`
- ⚠️ **Tailwind `dark:` 變體陷阱（實查 HeroUI theming 文件後補上）**：官方範例是 `<html class="dark" data-theme="dark">` —— **class 與屬性並用**。本計畫只用 `data-theme`（T40 明訂寫屬性不寫 classList），所以 **Tailwind 的 `dark:` utility 預設不會生效**。必須在 CSS 裡自訂變體：
  ```css
  @custom-variant dark (&:where([data-theme="fju-dark"], [data-theme="fju-dark"] *));
  ```
  不加的話 T40 會出現「token 有換色但 `dark:` class 全部失效」的難查症狀。
- 每個 theme 區塊都要設 `color-scheme: light` / `dark`（HeroUI 自訂主題範例的必要項，影響原生捲軸與表單控制項配色）
- HeroUI 的 `*-soft` / `*-hover` / `border-secondary` 等都是用 `color-mix()` 從基礎 token **自動算出來**的，所以只要定義 `--success` `--warning` `--danger` `--accent`，soft 變體免費取得；`--info` 因為不是預設 token，**它的 soft 變體要自己算**。
- **`<I18nProvider locale="zh-Hant-TW">`** 包在 `main.tsx`（R11 —— 不加的話 React Aria 的內建播報是英文）
- HeroUI v3 **不需要 Provider**

**檔案**：`frontend/vite.config.ts`, `pnpm-workspace.yaml`, `src/styles.css`, `src/theme/*`, `src/main.tsx`, `index.html`, `package.json`, `pnpm-lock.yaml`
**驗證**：build 成功且 **CSS bundle 沒暴增**（tree-shaking 有效）· 視覺與升級前一致 · devtools 確認 `--accent` 等 token 有值 · 切 `data-theme="fju-dark"` 時 token 有換（頁面此時還會很醜，正常）

---

### `12-self-host-fonts`
**Status**: done ✅ · **Depends**: `11-tailwind-heroui-tokens`

**T11 把字體延後了，且沒有任何後續任務認領它 —— 這個任務就是認領。**

T11 建好了 `src/theme/typography.css` 的字級與堆疊，但**沒有自行 host 字體**（理由正當：加 `@font-face` 會立刻重繪所有漢字，違反 T11「視覺不可變」的硬約束；而且 14MB 二進位檔應該和子集化決策放在一起）。**沒有接任何 CDN**，目前 fallback 到系統字體。

- `pnpm add @fontsource/noto-sans-tc`（5.3.0；解壓 68.2MB / 1977 檔，其中 **400/500/600/700 四個字重的 woff2 約 424 檔 / ~14MB**）
- @fontsource 提供的**本來就是 unicode-range 子集**，符合 §4.4 要求；只 import 需要的字重與子集，`font-display: swap`
- **只准 400/500/600/700**（§4.4-2）。Noto Sans TC 沒有 650/750/900 的實例，且 `font-synthesis: none` 擋掉合成
- 確認 `git` 不會因為 14MB 二進位檔膨脹 —— 若走 npm 依賴則不進版控，這是首選

**為什麼要排在 T30 之前**：T31–T36 全部都要在 375/768/1024/1440 四個寬度做視覺驗收。**CJK 字體 metrics 差異會直接改變換行、截斷與觸控目標高度**，用 fallback 字體驗收等於驗了一個使用者看不到的版面。

**驗證**：devtools 確認 `document.fonts.check('16px "Noto Sans TC"')` 為 true · 網路面板確認只載入需要的子集 · CSS/JS bundle 影響記錄下來

---

## 階段 2 — 結構拆分

### `20-split-app-structure`
**Status**: done ✅ · **Depends**: `11-tailwind-heroui-tokens`

把 1185 行 `App.tsx` 拆成計畫 §6.1 的目錄結構。**純搬移 + 加 lazy route，不改視覺、不改行為。**

- 建立 `app/ pages/ components/ hooks/ data/ domain/ theme/`
- `App.tsx` 縮到只剩 shell（~80 行）；六個頁面各自成模組
- `CourseCard`（101 行，三個頁面共用）→ `components/CourseCard/`
- `ScheduleWorkspace.tsx` 的四個內部元件拆檔：`ManualCoursePanel`(85) `CourseDetails`(17) `SlotRecommendationDialog`(66，**11 個 props 的 prop-bag，順便改用 context**) `ScheduleWorkspace`(282)
- **Path alias `@/*` 要同時加在三個地方**：`tsconfig.app.json`、`vite.config.ts`、**`vitest.config.ts`**（獨立 root config，不繼承）
- 路由層級 `React.lazy` + `<Suspense>`（現在是單一 317kB chunk、零 code splitting）
- 加 `<ErrorBoundary>`（目前完全沒有）與 `*` 404 路由（目前未知路徑渲染空白 `<main>`）
- **修 `RouteFocusManager` 的單一 `<h1>` 契約**（R9）—— 目前被 `ScheduleWorkspace:499+501` 與 `SchedulePage:255/256` 違反。加測試釘住

**檔案**：`frontend/src/**` 大規模搬移；`tsconfig.app.json`, `vite.config.ts`, `vitest.config.ts`
**驗證**：測試全綠（import 路徑會大量更新）· build 產出**多個 chunk** · 手動走過五個頁面 · 每個路由恰好一個 `<h1>`

---

### `21-data-layer-query`
**Status**: done ✅ · **Depends**: `20-split-app-structure`

```bash
pnpm add @tanstack/react-query@^5.102.2
```

- `data/queries.ts` 收斂 7 個 GET 端點：`getFacets` `getDepartmentCatalog` `getClassGroups` `getCourses` `getCoursesByIds` `lookupCourses` `getFeatures`
- **明確排除**（計畫 §6.4）：`db.ts`（本地使用者資料）· `getCatalog`/`getEmbeddingBundle`（已有更好的 sha256 內容定址快取）
- `embedQuery` / `askCourseAssistant` → `useMutation`
- 消滅 6 種不一致的 loading/error 寫法。特別修：`App.tsx:565` 與 `:913` 的**逐字重複 + `.catch(() => undefined)` 吞錯誤**；`RecommendPage:685-712` 的無取消 race
- **修 `useStore` 的 O(N) IndexedDB 放大**（計畫 §6.3-1）—— provider 層單一訂閱，context 下發
- **統一 context**：`profile` 與 `plans` 都走 context，移除雙軌與三層 prop drilling
- `api.ts` 已支援 `AbortSignal` 的兩個函式直接接 `queryFn: ({ signal }) => ...`
- 注意 v5 是 `isPending` 不是 `isLoading`

**檔案**：`frontend/src/data/queries.ts`, `hooks/`, `app/`, `pages/**`
**驗證**：測試全綠 · devtools Network 確認 `facets` **只請求一次**（現在兩次）· 25 筆結果時 IndexedDB 讀取從 25 次降到 1 次 · 快速切換篩選不出現過期結果

---

## 階段 3 — UI 遷移（T30 先行，之後 T31–T36 可平行）

> 每個任務都要遵守計畫 §5 的手機優先約束，並在報告中明確列出用了哪些 HeroUI 元件。

### `30-ui-primitives-heroui`
**Status**: done ✅ · **Depends**: `21-data-layer-query`

`ui.tsx` → HeroUI。**最高風險也最高槓桿；`ui.test.tsx` 已經覆蓋它。**

> ### ⚠️ T11 交棒：本任務是「第一個真正用 HeroUI 元件」的任務，有三件事必須在這裡處理
>
> **1. 重新開啟 Tailwind preflight。** T11 用的是 `tailwindcss/theme.css` + `tailwindcss/utilities.css`，**刻意跳過 preflight**（原因量測過、寫在 `styles.css` 開頭的註解裡）。`border-*` 寬度 utility 需要 preflight 的 `border-style: solid` 預設，所以這裡必須換回 `@import "tailwindcss";`。**換回去會重現 T11 量到的四個回歸，要在本任務一併修掉**：未套樣式的 `h2` 從 24px/700 塌成 16px/400 · 全域 `line-height` `normal` → 1.5（多數區塊高 2–3px）· `p` 失去 UA margin · `svg` 從 `inline` 變 `block`。
>
> **2. HeroUI 元件 CSS 是「按元件逐一 import」的。** T11 發現直接 `@import "@heroui/styles"` 這個 barrel 會把 84 個元件樣式全拉進來，**CSS 從 40.29 kB 爆到 454.21 kB**（BEM 純 CSS 規則 Tailwind 無法 tree-shake）。現在用的是 HeroUI 官方文件的 selective import。**每採用一個新元件，就要加一行對應的 `@import "@heroui/styles/components/<name>.css" layer(components);`** —— 否則元件會渲染成無樣式。T31–T36 同此。
>
> **3. 三個 token 目前被舊 CSS 遮蔽，不是壞掉。** 舊 `styles.css` 在**未分層的 `:root`** 上宣告變數，這會贏過任何 layered theme 區塊。`--muted`(#667069) · `--danger`(#a93232) · `--focus`(#0d5238) **刻意維持被遮蔽**，因為舊規則正在用它們。它們會在 T41 舊 CSS 死掉時自動接上新值。**在那之前引用這三個 token 拿到的是舊值，不是 §4.2 的新值。**

- `Modal` → `Modal.Backdrop`/`Container`/`Dialog`/`Header`/`Body`/`Footer`。**刪掉手寫的 `focusableSelector` Tab 循環器** —— React Aria 已含 focus trap + scroll lock + Escape + return-focus
- `ConfirmDialog` → **`AlertDialog`**（HeroUI 有專用元件）
- `FeedbackProvider` → **`Toast.Provider placement="bottom end"` + `ToastQueue`**
- **收斂三套並存的回饋機制**（計畫 §6.3-3）：`ScheduleWorkspace` 的 `.undo-toast`(:518) 與 `ManualCoursePanel` 的 `.notice`(:131) 全部併入 Toast
- 保留 `FeedbackAction`（`ui.tsx:16-19`）的「復原」契約 → `Toast.ActionButton` + `timeout: 6000`
- 保留 tone→politeness 對應（danger = assertive）
- **保留 skip link 自訂**（HeroUI 沒有這個 primitive）
- 建立共用狀態元件：`<StateAlert>`（取代 13 處 `.notice`）· `<EmptyState>` 三種子狀態（首次 / 過度篩選 / 缺前置設定）· `<LoadingSkeleton>`

**檔案**：`frontend/src/components/ui/**`, `ui.test.tsx`
**驗證**：`ui.test.tsx` 2 個測試全綠（focus trap / Escape / return-focus / 復原 toast）· 鍵盤逐項測 Modal 與 Drawer · **手機上 Drawer 的 focus trap**

---

### `31-course-card-heroui`
**Status**: done ✅ · **Depends**: `30-ui-primitives-heroui`

`CourseCard`（三個頁面共用，曝光最高）。

`Card` + `Card.Header`/`Content`/`Footer` · 狀態 → `Chip color={success|warning|danger} variant="soft"` **+ Phosphor 圖示**（計畫 §4.3，三重通道）· 類別標籤 → 中性 `Chip` + 前導色條（**不可重用語意色**）· 收藏 → `ToggleButton isIconOnly` + `Tooltip` + `aria-label` · `details` → `Disclosure` · 警語 → `Alert status="warning"` · 課程變體 → `RadioGroup`（**刪掉 `courseVariants.css`**）· 操作 → `Button isPending`

**修掉 `.meta span` 的 12.5px** → 15px（計畫 §4.4-4）。

⚠️ **T02 交棒：修課資格有「兩套文案」，不是一套。** 合併時發現**四個 enum 值全部文案不同**，已並存於 `eligibility.ts`（有測試釘死兩份字串，防止未來誤合併）。T31 用長版、T35 的時段對話框用短版，**維持現狀**：

| status | `eligibilityStatusLabels`（長／課程卡） | `eligibilityStatusShortLabels`（短／課表對話框） |
|---|---|---|
| `no_known_restriction` | 尚未判定出明確限制 | 未見限制 |
| `eligible_confirmed` | 條件已符合 | 資格符合 |
| `blocked_confirmed` | 目前不可修 | 資格不符 |
| `needs_confirmation` | 需要確認 | 資格待確認 |

計畫 §4.3 的狀態表用的是**長版**字樣。套 Chip + Phosphor 圖示時兩套都要接上三重通道，別只做長版。
⚠️ **R3**：`category` 與 `eligibility` 的 class 是 runtime 組出來的 —— 改用 data 屬性或 `@source inline(...)` 明確保留，並加 render 測試斷言狀態 chip 有正確視覺 token。

**手機驗收**：375px 下卡片單欄無橫捲 · 三個操作按鈕 ≥44px 且不擠 · 課名長時正確換行（CJK 自由換行、英文不從中切斷）

---

### `32-onboarding-heroui`
**Status**: done ✅ · **Depends**: `30-ui-primitives-heroui`

300 行、11 個 useState、6 個 effect 的最大單一元件。

`Form`(`validationBehavior="native"`) + `Fieldset` · 部別/班別 → `Select` · **系所 → `ComboBox`（不是 `Autocomplete`，理由見計畫 §4.5）** · 年級 → `RadioGroup orientation="horizontal"` · 自動加必修 → `Switch` · 錯誤 → `FieldError`（自動關聯）

**`ComboBox` 必要 props**：`menuTrigger="focus"` · `allowsCustomValue={false}` · `defaultFilter` **直接復用 `domain/departmentOptions.ts` 的 `filterDepartmentOptions`** · `formValue="key"`。分組用 `ListBox.Section` + `Header`。

**順手修**：`form` state 是 `profile` 的完整複本且初始值算了兩次（:282-296 與 :355-365 近乎相同的 10 行物件字面量）· `departmentInput` 鏡射 `selectedDepartmentOption` 還要靠 `departmentSearchTerm` 反鏡射 · **`getClassGroups` 失敗會寫進 `setSaveError`，導致班別載入失敗顯示成「儲存失敗：…」**（`App.tsx:331-333`，真 bug）

**T02 交棒的待決項**：原本掛著卻從未被 focus 的 `validationSummaryRef` 已刪除，但**元素的 `role="alert"` 與 `tabIndex={-1}` 刻意保留**（DOM 不變）。所以「送出失敗時把焦點移到錯誤摘要」這個常見表單無障礙模式**目前並不存在**。改用 `Form` + `FieldError` 時一併決定：要嘛實作 focus-on-error，要嘛就把沒用到的 `tabIndex={-1}` 拿掉，別留著半套。

**驗證**：`departmentOptions.test.ts`（7 個）守住篩選邏輯 · 鍵盤完整操作（上下鍵/Enter/Escape/外點關閉）· **手機上 ComboBox 彈出層不被鍵盤遮住**

---

### `33-recommend-page-heroui`
**Status**: done ✅ · **Depends**: `30-ui-primitives-heroui`

**手機體驗改善最大的一項**（計畫 §5.2）。

- **刪掉 `.hero`** —— `clamp(2rem,5vw,4rem)` padding 的綠色大區塊。改成兩行標題 + `Chip` 顯示 `● Local-first`。**單這一項就回收約 180px 首屏**
- 查詢框 → `Card` + `TextArea`（**刪掉 `margin:-1.5rem auto` / `width:calc(100% - 4rem)` 負邊距 hack**）
- 三個 `<details>` 篩選群組 → `Accordion variant="surface"`
- 巢狀 `filter-advanced` → `Disclosure`（**手機上取消巢狀，平鋪到各組底部**）
- 已套用篩選 pill → **`TagGroup` + `Tag.RemoveButton`**（取代 8 行近乎相同的手寫 `<span aria-hidden>×</span>`）
- 星期/學分多選 → `ToggleButtonGroup selectionMode="multiple"`
- 先修/程度單選 → `RadioGroup`（**刪掉 `.radio-choice input{position:absolute;opacity:0}` 隱藏 input 的技巧**）
- 開關類 → `Switch`
- **`lg` 以上：320px 篩選側欄 + 結果並排；`lg` 以下：篩選收進 `Drawer placement="bottom"`**，sticky 觸發按鈕帶 `Badge`(activeFilterCount)，**已套用篩選 TagGroup 永遠留在頁面上**，drawer footer sticky（清除全部 / 套用 N 項），**關閉時才套用**
- 結果網格最多 2 欄（3 欄會把課名擠成每行 2 字）

**手機驗收**：375px 下從查詢框到第一張結果卡 **≤1 個螢幕捲動**（現在約 4 個）· Drawer 可下拉關閉 · 篩選 chip ≥44px

---

### `34-explore-page-heroui`
**Status**: done ✅ · **Depends**: `30-ui-primitives-heroui`

搜尋 → `SearchField`（保留 300ms debounce）· 開課系所 → `ComboBox`（清單長，要可搜）· 星期 → `Select` · 分頁 → `Pagination` + `Pagination.Summary`

**版面隨斷點切換**：`lg` 以上用 `Table`（課號/課名/教師/時間/學分/系所/資格，`allowsSorting`）—— 目錄瀏覽是「比較」不是「閱讀」；**`lg` 以下維持卡片**。`Table.Content` 需要 `aria-label`。
Skeleton 高度對齊 Table row（避免版面跳動）。

**手機驗收**：375px 下是卡片不是表格 · 三個篩選器不擠成一團 · 分頁按鈕 ≥44px

---

### `35-schedule-workspace-heroui`
**Status**: done ✅ · **Depends**: `30-ui-primitives-heroui`

**只換周邊 chrome 與配色，格線本體不重建**（計畫 §4.5）。

保持自訂：`.schedule-grid` CSS Grid · `.class-block` 跨列定位 · `role="grid"/columnheader/rowheader/gridcell` · roving tabindex + `onSlotKeyDown` 二維導航 · `@media print` · 衝堂斜線紋理

換成 HeroUI：方案切換 → `Tabs` · `.segmented-control` → `ToggleButtonGroup disallowEmptySelection` · 工具列 → `Toolbar`(**需 `aria-label`**) · 課程詳情 → `Drawer placement="right"`（桌機）/ `placement="bottom"` + `Drawer.Handle`（手機）· `.undo-toast` → `Toast` · 方案命名 → `Modal` · 衝堂/未排入警示 → `Alert`

**修掉**：`.schedule-slot-button` 靜止態 `color:#456a52; opacity:.42` ≈ **2.6:1，低於門檻**，而它是「找空堂課」的主要 affordance → 改用 `--muted`
⚠️ 但注意 T30 交棒事項 3：`--muted` **在 T41 之前仍被舊 CSS 的 `#667069` 遮蔽**，所以此時拿到的不是 §4.2 那個 6.39:1 的值。修正方向仍然正確（遠優於 2.6:1），但**報告時不要宣稱 6.39:1** —— 實測當下的值，並在 T41 重新驗一次。
**修掉**：`.class-block[data-course-name]::after` 的純 CSS tooltip **對螢幕閱讀器完全不存在** → `Tooltip`（React Aria 會接 `aria-describedby`）
**補上**：格線缺少 `aria-rowcount`/`aria-colcount`/`aria-rowindex`/`aria-colindex`
**重構**：手機列表 (`:516`) 與桌機格線目前**重複了 block markup** → 抽共用 `<ClassBlock>`；`<select>` 選日 → `ToggleButtonGroup`（一~五在 44px 下剛好一排）

⚠️ **T01 交棒的兩個約束（測試現在綁在這上面）**：
1. **class block 的 `aria-label` 格式是 `${課名}，星期…`（全形逗號緊接課名）** —— T01 的測試用 `/，星期/` 與 `/^日間課程，/` 兩個 regex 依賴它。抽共用 `<ClassBlock>` 時若重排這個 label，**這兩個查詢會直接紅**。要改就同步改測試，別讓它靜默失效。
2. **compact-mode 的 `.schedule-hidden-notice`（:506）目前沒有任何 role**，T01 只能用 `getByText(/n 門課/)` 查它。本任務把警示改成 `Alert` 時，**順手給它 `role="status"`** —— 這其實是現存的真無障礙缺陷：折疊模式靜默隱藏課程，螢幕閱讀器完全收不到通知。修好後測試可改回 role-based。

**驗證**：`ScheduleWorkspace.test.tsx` 6 個測試全綠（已於 T01 改成 role-based）· **列印預覽**仍正確 · 鍵盤二維導航仍可跳過已佔用格
**手機驗收**：375px 下是單日列表 · 768px 出現格線且可橫捲 · 1280px 五天免橫捲

---

### `36-data-assistant-pages`
**Status**: done ✅ · **Depends**: `30-ui-primitives-heroui`

**DataPage**：`.data-grid` → 2 欄 `Card` · `.big-stats` → `Card.Content` `dl` · 破壞性操作 → `AlertDialog` + `Button variant="danger"` · 儲存空間 → `Meter`(>80% 轉 `warning`)
⚠️ `importBackup` 每筆資料都觸發一次 `fju-local-data` 事件 —— 大備份會造成 re-render 風暴，順手改成批次後單次通知

**AssistantPage**：使用者選擇**保留**此頁（`AI_ASSISTANT_VISIBLE` 維持 `false`）。做最小遷移讓它跟上新設計系統即可，不投入額外心力。

**手機驗收**：375px 下 data-grid 單欄 · 匯入/匯出/清除按鈕 ≥44px

---

## 階段 4 — 收尾

> ## ✅ 已採納：T41 拆成 T41a / T41b，**T41a 排在 T40 之前**
> *依據：wave 3 三位審查者的實測，完整報告見 `.whl/review/wave3-heroui-pages.md`。使用者指示「繼續跑到計畫完成」，由 orchestrator 依實測結果定案。*
> **新執行順序：T41a → T40 → T41b → T42。**
>
> **為什麼**：T40 的驗收條件是「五個頁面 × 亮暗兩色全部檢查」。但實測顯示 `fju-dark` 下各頁**仍然是亮的**（以 luma>200 的畫素佔比計）：`/schedule` **94.5% 亮**、`/onboarding` 65.9%、`/recommend` 68.1%、`/data` 49.8%、`/explore` 34.3%。暗色對比共 **48 項不合格，最低 1.09:1**。
> 每一個成因都是 T41 本來就要刪的舊 CSS，而且**在 T40 的範圍內無解**：
> - unlayered `html{background:#f3f5f1}` 與每頁都白的 `header.topbar` —— 這是 `/recommend` 在暗色下**僅存**的兩塊亮色表面，代表 T33 的 page-scoped 補救已經做滿了頁面層級能做的事
> - `--muted` 被舊 `:root` 遮蔽，單獨貢獻 **48 項中的 31 項**；它只有在舊 `:root` 死掉時才會接上新值 —— 那按定義就是 T41
> - 課表格線的 `#fff` / `#dcecdf` / `#f7f9f6` 是寫死的 hex
> - T32/T33/T35/T36 的四份 `[data-page="…"] revert-layer` 補救都**設計成隨 T41 一起死**；在這層鷹架上蓋 T40 等於對著即將被拆掉的地基寫程式，然後全部重驗一次
>
> 計畫本身其實已經有這個循環矛盾：T41 寫「舊 `:root` 一死…要重新量一次這三者的對比度」，假設暗色已驗過；而 T40 的驗收又需要 T41 才解除遮蔽的 token。**實測結果讓這個循環往 T41 那邊倒。**
>
> **建議切法**
> - **T41a（先做，排在 T40 前）**：刪掉 unlayered 的舊 `:root`、`html{background}` 與 topbar 底色；替 `[data-theme="fju-dark"]` 補上 `--surface-secondary` / `--surface-tertiary`；把 `.schedule-grid` / `.schedule-day-header` / `.class-block` / slot hover 的寫死顏色換成 token；移除四份 page-scoped `revert-layer` 補救。
> - **T40（然後）**：主題切換、`blur-fade`、`number-ticker`、`useReducedMotion` —— 此時「五頁 × 亮暗」才是真的驗收，不是形式。
> - **T41b（最後）**：壓到 ≤120 行、`forced-colors`、列印重新稽核（含下方列印裁切修正）、字體決策結案。

### `40-dark-mode-and-motion`
**Status**: done ✅ · **Depends**: `31`–`36` 全部完成

- 暗色切換：**controlled** `animated-theme-toggler`，寫 `data-theme` 屬性（**不是 `classList`**），圖示用既有 `@phosphor-icons/react`（**不引入第二套圖示庫**），偏好存進 IndexedDB
- `blur-fade`：僅推薦結果卡片，**stagger index 上限 6**，參數 `0.22s / 3px / 4px`
- `number-ticker`：僅 ExplorePage 總數與 DataPage 統計。**兩處修補**：拿掉硬編碼 `text-black dark:text-white`；locale 改 `zh-Hant-TW`
- **`useReducedMotion()` hook**（計畫 §4.6 第 2 層）—— CSS `!important` **擋不住 motion/react 的 JS spring**，必須直接跳過 wrapper
- 全域 reduced-motion CSS 擴充 `::view-transition-*` 與 `--skeleton-animation: none`

```bash
pnpm add motion
```

> ### ⚠️ Magic UI 原始碼實查（orchestrator 已抓下三個 registry item，以下都是讀原始碼得到的，不是推測）
>
> **這三個元件都用 `npx shadcn` 安裝，但本專案沒有 shadcn，也沒有 `@/lib/utils` 的 `cn()`。三個都必須手動 vendor 並改寫。**
>
> **1. `animated-theme-toggler` —— 有 controlled 模式，但它「還是」會寫 class。**
> 它確實支援 `theme` + `onThemeChange` 的 controlled 用法（計畫要的就是這個），**但 `applyTheme()` 裡有一行無條件執行的 `document.documentElement.classList.toggle("dark")`**，原始碼註解說是為了讓 View Transitions 能在 callback 內快照到新主題。
> 這與計畫「只寫 `data-theme` 屬性、不寫 classList」直接衝突，也會和 T11 建立的 `@custom-variant dark (&:where([data-theme="fju-dark"], …))` 打架 —— 結果會是 class 與屬性各說各話。**vendor 進來時必須把那行改成寫 `data-theme`。**
> 另：它 `import { Moon, Sun } from "lucide-react"` —— 計畫明訂不引入第二套圖示庫，換成既有的 `@phosphor-icons/react`。
> 它用 View Transitions API，所以計畫 §4.6 說的 reduced-motion 要涵蓋 `::view-transition-*` 是**必要的，不是可選的**。
>
> **2. `number-ticker` —— 計畫列的兩處修補都確認存在，且有第三處。**
> - `Intl.NumberFormat("en-US", …)` 寫死 → 改 `zh-Hant-TW` ✅（計畫已列）
> - `className` 寫死 `text-black tabular-nums dark:text-white` → 拿掉 ✅（計畫已列）
> - **第三處（計畫未列）**：那個 `dark:text-white` 在本專案**本來就不會生效** —— 因為用的是 `data-theme` 而不是 `.dark` class。所以它在暗色下會是黑字。拿掉硬編碼顏色同時解決這點。
> - 它靠 `useInView` + `useSpring`（JS 驅動），**CSS 的 reduced-motion 擋不住**。
>
> **3. `blur-fade` —— `inView` 預設是 `false`，意思是「不等進入視窗、直接動」。** 計畫要的是推薦結果卡片的 stagger，要自己決定是否傳 `inView`。同樣是 JS 驅動的 spring/tween。
>
> **共同結論**：`number-ticker` 與 `blur-fade` 都相依 `motion`，且都是 JS 驅動 —— 這正是計畫 §4.6 第 2 層 `useReducedMotion()` hook **必須直接跳過 wrapper**（而不是靠 CSS `!important`）的原因。三個元件的 `cn()` 都要換成本專案既有的寫法。

**驗證**：五個頁面 × 亮暗兩色全部檢查 · 開啟系統「減少動態效果」後**確實**沒有動畫（含 JS 驅動的）· 暗色下所有對比度符合計畫 §4.2

> ### 🔴 T33–T36 交棒：暗色模式目前是**全站壞的**，不是個別頁面的問題
>
> 四個 agent 各自獨立量到同一個根因，這裡集中列出，**T40 必須先修這三項再談動效**，否則「五頁 × 亮暗」驗收無從做起：
>
> 1. **舊 CSS 的 unlayered `html{background:#f3f5f1}` 讓整個頁面底色在 `fju-dark` 下仍是亮的。** T34 實測未經修改的 `/recommend`：`html` 是 `rgb(243,245,241)`、topbar 全白。因此任何坐在透明面板上的元件（T33 的 toggle chip 量到 1.57、T34 的 pagination 數字 1.1:1）都是在對比一個亮底。**這不是各頁的鍋，是 T41 拆除目標的一部分**，但 T40 需要它才能驗收 —— 兩者的順序要重新確認。
> 2. **`--surface-secondary` / `--surface-tertiary` 在 `fju-dark` 下根本沒定義。** HeroUI 的暗色區塊選擇器是 `.dark, [data-theme="dark"]`，本專案永遠不會命中；`theme/fju.css` 只重述了 `--surface`，漏了這兩個，所以它們保留**亮色預設值**。T34 是第一個採用會讀這兩個 token 的元件的任務，實測在暗色頁面裡出現一塊 **1200×1997 的 `rgb(239,239,240)` 亮色板**。已在 T34 的 fence 內做 page-scoped 補救，**正解是補進 `theme/fju.css` §4.2**。
> 3. **課表格線本體的顏色是寫死的亮色**（`.schedule-grid{background:#fff}` 與各 block 色盤），完全不跟 `fju-dark` 走。T35 只改了 slot button 的顏色，其餘未動 —— 暗色截圖裡會看到一個 HeroUI 暗色 segmented control 坐在亮色卡片上。**目前無人認領，指派給 T40。**
>
> 另：T32 / T33 / T35 / T36 都各自加了 page-scoped 的 `revert-layer` 補救（`[data-page="onboarding|recommend|schedule|data"]`）。**它們全部設計成隨舊 `:root` 一起死**，T41 拆除時要一併移除，別留下來。

---

### `41-css-teardown`
**Status**: done ✅ · **Depends**: `40-dark-mode-and-motion`

把 `styles.css` 從 43KB 壓縮碼縮到目標 ≤120 行，**只留 HeroUI 蓋不到的部分**：skip link · 課表格線與 class block · `@media print` · `@media (forced-colors: active)` · reduced-motion · 類別色階。

> ### 🔴 T12 交棒：兩個字體決策必須在這裡結案（不是「順手」，是必辦）
>
> **1. CSS 從 12.49 kB gzip 暴增到 229.11 kB gzip，而且是 render-blocking。**
> 來源不是 `styles.css`，是 `theme/fonts.css`：fontsource 的 unicode-range 切片版有 105 條 `@font-face` × 4 個字重 = **420 條規則、約 486 kB 的十六進位 range 字串**，幾乎不可壓縮。
> **這個取捨本身是對的**：實際傳輸只有 15 個 woff2 / 491 kB，而不切片的版本每次冷載都要 ~4 MB。但 229 kB 阻塞渲染的 CSS 相對 12 kB 是**真回歸**，不能默默帶到驗收。三個可選解，**用量測決定，不要用猜的**：
> - (a) `fonts.css` 改成非阻塞載入（獨立 `<link>`，代價是 FOUT）—— 最小改動
> - (b) 砍字重。實測 `/recommend` 只下載了 400 與 700；500/600 只花 CSS 位元組。若設計實際只用得到兩個字重，CSS 直接砍半
> - (c) **自行子集化**。T12 已經量出真實語料只有 **5,179 個相異碼位**（`data/**.json` + `frontend/src`）。用 `pyftsubset` 對這 5,179 字打包，每個字重可壓成單一檔案、CSS 幾乎歸零。對「本地優先、語料封閉」的應用這是最正解，代價是多一個 build 期相依
>
> **2. `--font-latin` 的 `"Inter var"/"Inter"` 從來沒有被 host 或安裝過。** 目前拉丁字元實際上是用 Noto Sans TC 自帶的拉丁字形在渲染。這是 T11→T12 同一個「延後又沒人認領」的坑，第三次出現了。**要嘛加 `@fontsource-variable/inter`（variable font，單檔，latin 子集很小），要嘛把 Inter 從 token 拿掉。**
> ⚠️ 這會影響 **T34**：計畫 §4.4 選 Inter 的理由是「真 tabular figures」，而 T34 的 ExplorePage `Table` 要靠等寬數字對齊學分/時間欄。若決定不裝 Inter，T34 就得改用 `font-variant-numeric: tabular-nums` 並實測 Noto Sans TC 是否真的有這個 feature。
>
> ✅ **T34 已實測結案，這個決策現在有數據了**：
> - **Inter 確實完全不存在。** 用 `"Inter"` / `"Inter var"` 排的探針字串與用一個不存在的字體名排出來的結果**逐位元組相同**，代表直接 fall through 到 generic。而且 `--font-latin` 雖然有定義，**`--font-sans` 解析結果是空字串**，body 真正生效的字體堆疊來自舊 CSS 的 `"Noto Sans TC","Segoe UI",sans-serif`。
> - **Noto Sans TC 根本不需要 `tabular-nums`。** 十個數字在 100px 下逐一量測，**開不開這個 feature，每個字形的 advance 都是 55.5px（0.555em）** —— 它本來就是等寬數字。表格欄位今天就是對齊的。
> - 因此 **§4.4 選 Inter 的核心理由（真 tabular figures）對本專案不成立**。傾向直接把 Inter 從 token 拿掉，而不是為此再引入一個字體檔（那會再加一份 render-blocking CSS，與上面那條 229 kB 的取捨互相打架）。T34 保留了 `tabular-nums` 宣告，純粹是萬一未來真的裝了 Inter 也不會歪。

> ### 🔎 Wave 3 審查交棒：死 CSS 清單（**已實查，勿再憑報告猜**）
>
> **陷阱：`.segmented-control` 不是死的。** T35 的報告曾聲稱它與 `.plan-tabs` 一起死了 —— **只有 `.plan-tabs` 是死的**。`.segmented-control` 仍套用在 `ScheduleWorkspace.tsx:336` 的 HeroUI `ToggleButtonGroup` 上，`styles.css:272` 的規則是活的、且有作用（邊框 + `#f3f6f2` 底）。當成死的刪掉會讓檢視範圍控制項掉框掉底，**且沒有任何測試會紅**。
>
> 實查確認**確實已死**（`src/**` 非測試碼中零個 `className` 參照）：
> `.pager` · `.filters-bar`（含其 `@media(max-width:800px)`）· `.big-stats`(+`span`/`strong`) · `.data-grid`(+`.card`，含其 media query) · `.danger-button` · `.list-card` · `.choice-row` · `.form-grid`(+`label`/`fieldset`/`small`/`.wide`) · `.undo-toast`（含兩條 media query）· `.schedule-conflict-summary` · `.plan-tabs`
> 另：`@media print` 的 hide-list 仍點名已死的 `.plan-tabs` 與 `.undo-toast`，一併清。
>
> **`.hero` / `.privacy-pill` 仍活著**：T33 刻意不刪（當時 AssistantPage 還在用），但 T36 遷移 AssistantPage 時**保留了 `.hero`**（`pages/assistant/AssistantPage.tsx:119`），沒人收尾。要嘛把該頁改掉再刪 CSS，要嘛承認它留下。
>
> **`slot-category-filter ${category}`（`SlotRecommendationDialog.tsx:34`）是全站最後一個 runtime 組合 class name**（R3/B3）。它的規則住在逐字保留的舊 sheet 裡所以今天安全，但 T41 動那段時它會第一個中招。
>
> ### 🔴 統一五份重複的 `revert-layer` 補救（審查發現 8）
> 舊 `button{...}` 是 **unlayered**，無條件贏過所有 layered 規則，所以每個頁面都自己寫了一份一模一樣的 `revert-layer` 修補：`styles.css:604`(T32) · `:706`(T33) · `:797`(T35) · `:880`(T36) · `:975`(T34)。五組 selector、五種 scope、三種 portal 策略，44px 下限還有三種寫法（`min-h-11` / `min-height:44px` / `min-height:2.75rem`），`input/textarea` 的修補也重複了三份。
> **正解是一條全域 unlayered 規則**，可同時覆蓋五個頁面與兩個沒被蓋到的 portal。T41 拆掉舊 `:root` 時這五份要一起消失。

- 刪掉 `courseVariants.css`
- 加 `@media (forced-colors: active)` —— **Windows 高對比會剝除背景色，等於抹掉整個修課資格訊號**，每個狀態 chip 要給 `border: 1px solid CanvasText`
- **列印樣式重新稽核（R10）** —— HeroUI 的 Drawer/Modal 走 portal 到 `document.body`，hide-list 要加 `[data-rac][role="dialog"]`
- `[id]{scroll-margin-top}` 對齊新的 64px sticky header
- **舊 `:root` 一死，`--muted` / `--danger` / `--focus` 三個 token 會自動從被遮蔽狀態接上 §4.2 的新值**（見 T30 交棒事項 3）。**這是全站錯誤文字與 focus 外框顏色改變的時刻** —— 要重新量一次這三者的對比度，並確認 focus ring 仍是 7.77:1。

**驗證**：`pnpm build` 的 CSS chunk 明顯縮小 · 五頁 × 亮暗 × 四寬度全部回歸 · 列印預覽 · Windows 高對比模式（或 devtools `forced-colors` 模擬）

---

### `42-final-verification`
**Status**: done ✅ · **Depends**: `41-css-teardown`

- ~~🔴 **T30 發現的真 i18n bug，必修**：React Aria 的 toast region 播報簡體「1 个通知。」~~
  ✅ **已解決，wave 3 審查實測不再重現。** 瀏覽器實際擷取到的是 `aria-label="1 個通知。"`（繁體「個」U+500B）。原因是 **T32 把 `I18nProvider` 的 locale 從 `zh-Hant-TW` 改成 `zh-TW`** —— React Aria 只 bundle `zh-CN` 與 `zh-TW` 兩包，`zh-Hant-TW` 的 fallback 鏈會掉到 `zh-CN`，改成 `zh-TW` 就正確命中繁體。**T42 不需要再做這項**，也不需要自訂 `LocalizedStringProvider`。
- 全站鍵盤走查：skip link → 路由焦點 → Modal/Drawer focus trap → ComboBox → 課表二維導航 → 方案 tablist
- Lighthouse a11y（chrome-devtools MCP `lighthouse_audit`），desktop + mobile 各一次
- **四寬度 × 亮暗 × 五頁**完整截圖回歸
- **`docker compose build` 實跑一次**（R14 —— CI **沒有** Docker build 步驟，`Dockerfile:18` 寫死 `frontend/dist`，改到 outDir 會直接爆）
  ⚠️ **T12 交棒**：`dist/` 從 2.2 MB / 27 個檔案變成 **11.79 MB / 431 個檔案**（404 個 hashed woff2）。`Dockerfile:18` 是 `COPY --from=frontend /app/frontend/dist/`，所以**這就是 runtime image 的體積增量**。T12 已加了一個 build-only Vite plugin 砍掉 fontsource 的 legacy `.woff` 孿生檔（否則是 23.3 MB / 839 檔）。若 T41 選了自行子集化，這個數字會再大幅下降 —— **docker build 的體積要在兩者之後才量**。
- Bundle 比對基線：**316.94 kB JS / 103.66 kB gzip · 43.51 kB CSS / 9.35 kB gzip**。code splitting 之後應該要有多個 chunk；**若總量明顯上升要說明原因**
- 更新 `README.md` / `DEPLOYMENT.md` 中過時的前端說明

**驗證**：完整測試 + 型別 + build + Docker build 全綠；產出 `.whl/review/` 報告

> ### 📌 T33–T36 留下的兩個**待使用者決定**事項（不是 bug，是範圍問題）
>
> 1. **ExplorePage 桌機版表格沒有任何操作。** 規格只點名七個欄位（課號/課名/教師/時間/學分/系所/資格），T34 照做，課名欄連到官方課綱。結果是：**`lg` 以上的使用者只能瀏覽、不能加入課表或標記已修**，但 1023px 以下的卡片版每個操作都在。要嘛加第八個操作欄，要嘛做 row-detail `Drawer`，要嘛就接受「桌機表格是純比較檢視」。**需要決定。**
> 2. **`/api/v1/courses` 沒有排序方向參數**（`web.py:203` 只有排序欄位）。所以 T34 的表格排序**只作用在當前這一頁的 25 筆**，UI 已明說。要做成全域排序必須加後端 `sort_dir` —— 計畫 §1 明訂後端重構 out of scope，因此**留作獨立後續項**，不在本次重構內。
>
> ### ⚠️ 工具鏈教訓（給未來的並行 wave）
> **`git stash` 在 worktree 之間是共用的** —— 一個 `.git` 目錄只有一個 stash stack。T33 與 T34 同時 stash，pop 時互相把對方的工作樹拉進自己的 worktree。兩邊都從 dangling stash commit 復原、也都驗證過樹是乾淨的，但這是**真的差點掉工作**。並行 worktree 中一律用 `cp` 到 `/tmp`，不要用 `git stash`。

---

## 相依圖

```
00-config-cruft-fix
├── 01-detest-classnames ──┐
└── 02-extract-inline-logic┤
    01 → 03-dead-code-purge┤
                           └──→ 10-upgrade-stack-atomic
                                 └→ 11-tailwind-heroui-tokens
                                     └→ 20-split-app-structure
                                         └→ 21-data-layer-query
                                             └→ 30-ui-primitives-heroui
                                                 ├→ 31-course-card-heroui      ┐
                                                 ├→ 32-onboarding-heroui       │
                                                 ├→ 33-recommend-page-heroui   ├ 可平行
                                                 ├→ 34-explore-page-heroui     │
                                                 ├→ 35-schedule-workspace-heroui│
                                                 └→ 36-data-assistant-pages    ┘
                                                     └→ 40-dark-mode-and-motion
                                                         └→ 41-css-teardown
                                                             └→ 42-final-verification
```

**串行 10 個任務 + 一波 6 個平行任務。** 階段 0 的 T01/T02 可平行。
