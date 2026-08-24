# 前端整體重構計畫 — FJU 選課指南

**建立日期**：2026-08-24
**模式**：`/whl plan` → 交棒給 `/whl implement`
**狀態**：待實作

---

## 1. 目標

把現在的 9.4k 行前端（1185 行 `App.tsx` 單體 + 43KB 手寫壓縮 CSS + React 18/Vite 5）重構成：

- **結構**：拆成 `app / pages / components / hooks / domain` 分層，單一檔案不超過 ~250 行
- **視覺**：全新設計系統（Tailwind v4 + HeroUI v3 + 自訂 token），含亮色/暗色雙模式
- **技術**：升級到 React 19 / Vite 8 / React Router 8 / Vitest 4
- **資料層**：TanStack Query 統一 API 拿取（本地 IndexedDB 與 sha256 artifact 快取維持現狀）
- **跨平台**：**手機介面為第一優先約束**，不是最後補的 media query

### 明確不做（out of scope）

| 項目 | 原因 |
|---|---|
| TypeScript 7（原生 Go 編譯器） | `tsc -b` 的 project references 是最可能行為改變的地方。`^5.7.2` 正確鎖在 5.9.3，另案處理 |
| 後端 Python 重構 | 僅動 `web.py` 的靜態檔 fallback 一處（見 T03） |
| `getRouteBundle` / `embedQueries` | 已接線但無任何元件使用，原樣保留 |
| AI 小幫手功能復活 | 使用者選擇保留頁面程式碼，但 `AI_ASSISTANT_VISIBLE` 維持 `false` |
| 虛擬化系所清單 | React Aria collection 已夠 lazy；先量測再說，不預先加 |

---

## 2. 使用者已確認的決策

| 決策 | 選擇 |
|---|---|
| 重構範圍 | 結構重構 + 視覺改版 |
| 視覺自由度 | 可自由重新設計（保留資訊架構與功能） |
| 套件版本 | 升到最新 |
| 品質底線 | 測試全綠 · 型別與 build 過 · 無障礙不可退步 · 分階段可合併 commit |
| 主色調 | **換深藍 `#1A4E8A`；綠色只當「條件已符合」語意色** |
| 暗色模式 | **做，一次到位** |
| 資料層 | **導入 TanStack Query，但只管 API** |
| 死程式碼 | 修 vite.config 重複檔 · 刪 ~3.5KB 死 CSS · 刪舊版 `web_assets` |
| 跨平台 | **手機介面須兼顧（使用者中途補充）** |

---

## 3. 研究結論摘要

五個研究 agent 的完整報告在對話記錄中；以下是影響計畫的關鍵事實。

### 3.1 目前狀態基線（實測，非推測）

```
vitest run   → 14 檔 / 100 測試全數通過（vitest 2.1.9）
tsc -b       → 0 錯誤
vite build   → 成功，316.94 kB JS / 103.66 kB gzip；43.51 kB CSS / 9.35 kB gzip
             + 1.22 MB sourcemap（sourcemap: true，會被公開serve）
```

100 個測試中 **92 個是純邏輯（重構安全）**，**8 個是 DOM 測試（有風險）**：`ScheduleWorkspace.test.tsx` 6 個 + `ui.test.tsx` 2 個。

### 3.2 三個必須先處理的阻塞問題

**B1 — `vite.config.js` 是被誤入版控的編譯產物，且 Vite 實際載入它。**
Vite 的 `DEFAULT_CONFIG_FILES` 順序是 `vite.config.js` → `.mjs` → `.ts`，第一個命中就停。`tsconfig.node.json` 設 `composite: true` 但**沒設 `noEmit`**，所以 `tsc -b` 會把 `vite.config.ts` 編譯成 `.js` + `.d.ts` 吐在原地，兩個都被 commit 了。
**後果：改 `vite.config.ts` 後跑 `pnpm dev` 完全無效。** 加 Tailwind plugin 時會第一個踩到。

**B2 — 8 個 DOM 測試綁死 CSS class 名。**
`ScheduleWorkspace.test.tsx` 用 `container.querySelector` 抓 `.schedule-grid` `.class-block` `.slot-category-filter.home_elective` `.slot-recommendation-actions button` 等 ~15 個 class，外加 4 個精確 aria-label 字串。**任何 class 改名或 JSX 重排都會讓 CI 紅掉。**

**B3 — 有 8 個 class 名是從 TypeScript union 值在 runtime 組出來的。**
`` `category-tag ${recommendation.category}` ``、`` `status ${recommendation.eligibility}` ``、`` `slot-category-filter ${category}` ``、`` `toast-${feedback.tone}` ``。
**任何 CSS purge / dead-code 工具都會靜默刪掉 `.home_required` `.eligible_confirmed` `.blocked_confirmed` 等並弄壞 UI。** 靜態分析看不到它們。

### 3.3 套件版本現況（2026-08-24，來源見下方註記）

> ⚠️ **context7 MCP 配額用盡**（帳號層級硬阻擋，非單次查詢）。負責套件研究的 agent 改用 **npm registry API** 讀取實際 manifest 的 `engines` / `peerDependencies`，以及各官方文件頁面，並逐條標註來源。**本節沒有任何一條來自模型記憶。** 實作前若 context7 恢復，值得重新驗證一次。

| 套件 | 目前 | 最新穩定 | 硬性限制 |
|---|---|---|---|
| react / react-dom | 18.3.1 | **19.2.8** | — |
| vite | 5.4.11 | **8.2.2** | — |
| @vitejs/plugin-react | 4.3.4 | **6.1.0** | peer `vite: "^8.0.0"` — **只吃 v8** |
| react-router-dom | 7.1.1 | **套件已移除** | v8 起併回 `react-router` |
| react-router | — | **8.3.0** | peer `react: ">=19.2.7"`；`engines.node: ">=22.22.0"` |
| vitest | 2.1.8 | **4.1.11** | peer `vite: "^6\|^7\|^8"`（**非 optional**） |
| jsdom | 25.0.1 | **30.0.1** | `engines.node: "^22.22.2 \|\| ^24.15.0 \|\| >=26"` |
| tailwindcss | 無 | **4.3.3** | peer `vite: "^5.2\|^6\|^7\|^8"` — **可獨立導入** |
| @heroui/react | 無 | **3.2.4（stable，非 beta）** | peer `react: ">=19"`, `tailwindcss: ">=4"` |
| @tanstack/react-query | 無 | **5.102.2** | peer `react: "^18 \|\| ^19"` — **可獨立導入** |
| @testing-library/react | 16.3.2 | 16.3.2 | 已支援 React 19，免動 |

**注意：heroui-react MCP 自己的說明仍寫 v3 是 BETA，但 npm 的 `latest` tag 是 `3.2.4`。以 npm 為準，MCP 說明已過期。**

#### 被 peer dependency 綁成一包、無法拆開升的（T10）

```
React 19  ─┬─→ react-router 8   （peer react >=19.2.7）
           └─→ @heroui/react 3  （peer react >=19）
Vite 8    ─┬─→ plugin-react 6   （peer vite ^8，只吃 8）
           └─→ vitest 4         （peer vite ^6|^7|^8，非 optional）
```
可獨立先落地的只有兩個：**Tailwind v4**（吃 vite ^5.2+）與 **TanStack Query**（吃 react ^18）。

#### Node 版本底線

交集後的安全底線是 **22.22.2+ / 24.15.0+ / 26+**。
`Dockerfile:1` 是 `node:22-alpine`、CI 是 `node-version: 22` —— 都是浮動 tag，**目前會解析到符合的版本**，但必須釘死，否則哪天 runner 快取到舊 22.x 就 install 失敗。

#### 瀏覽器底線（跨平台重點）

導入 Tailwind v4 後底線變成 **Chrome 111 / Edge 111 / Firefox 128 / Safari 16.4**（需要 `@property` 與 `color-mix()`）。
Safari 16.4 = iOS 16.4（2023-03）。**Tailwind v4 的 Firefox 128 比 Vite 8 預設 target 的 114 更嚴，Tailwind 是綁定條件。** 若之後發現需支援更舊的 iOS，唯一解是退回 Tailwind 3.4。

### 3.4 CSS 現況

- 只有 **10 個 CSS 變數**，其中 `--focus` 是 `--green` 的重複、`var(--card)` **從未定義**
- **~180 個硬編碼 hex** 繞過 token；12 種 radius；15 種未管理的 z-index；7 種陰影配方
- **完全沒有暗色模式**（沒有 `prefers-color-scheme` / `color-scheme` / `[data-theme]`）
- 9 個各自為政的 `max-width:800px` 區塊；`.course-grid` 的 `grid-template-columns` **被設定 7 次**，靠行內串接順序決勝負
- 29 個 `!important`；`.field-error` 被定義兩次且顏色互相打架
- `styles.css` 是**壓縮過的原始碼**（第 1 行 7543 字元），**格式化它會產生觸及每一行的 diff 並可能重排規則**

### 3.5 已知的無障礙資產（不可退步）

現有實作水準其實高於平均，這些必須保留或做得更好：

- `.skip-link`（`App.tsx:197`）
- `RouteFocusManager`（`App.tsx:160`）—— 契約是「每個路由在 `#main-content` 內恰好一個 `<h1>`」。**此契約目前已被 `ScheduleWorkspace:499+501` 與 `SchedulePage:255/256` 違反**，重構時順手修掉
- `Modal` 完整 focus trap：`inert` on `.app-shell`、scroll lock、Tab 循環、Escape、return-focus（`ui.tsx:121-160`）
- 系所 combobox 完整 ARIA 1.2 pattern（`App.tsx:476-548`）
- 課表 `role="grid"` + roving tabindex + 二維方向鍵導航（`ScheduleWorkspace.tsx:508-511, 402-432`）
- 方案 tablist 的 roving tabindex + Home/End（`ScheduleWorkspace.tsx:458-465`）
- `@media print` 課表列印樣式
- `prefers-reduced-motion` 全域區塊

---

## 4. 設計規格

完整規格由設計 agent 產出（已通過 `ui-ux-pro-max` skill + heroui-react MCP `list_components`/`get_component_docs` ×40/`get_theme_variables` + magicuidesign-mcp `getRegistryItem` 三道硬性門檻）。以下是實作時必須遵守的定案。

### 4.1 設計方向：「自習室 / Reading Room」

紙墨資訊介面。暖色低彩度畫布、**單一**深學術藍強調色、**用邊框與分隔線而非陰影**建立結構、嚴格 4px 空間格線、為 CJK 閱讀而非行銷 hero 調校的字體。**顏色幾乎只花在「狀態」上，絕不用於裝飾。**

依據：`ui-ux-pro-max --domain style` 的 "Data-Dense Dashboard"（效能 ⚡ Excellent、WCAG AA、Tailwind 10/10）與 "Minimalism & Swiss Style"（WCAG AAA），但**刻意放寬其 `--font-size-small: 12px` 與 `--card-padding: 12px`** —— 那些數值假設拉丁文字，12px 漢字無法閱讀。

### 4.2 色彩 token

完整亮色 + 暗色 token 組（oklch）寫在 `src/theme/fju.css`，以 `[data-theme="fju"]` / `[data-theme="fju-dark"]` 掛載。核心值：

| 用途 | 亮色 | 暗色 |
|---|---|---|
| `--background` | `#F7F6F3` 暖紙 | `#0F1114` |
| `--foreground` | `#16181D` | `#E9EAEC` |
| `--accent` | **`#1A4E8A`** 學術靛藍 | `#8CB8F0` |
| `--success` 條件已符合 | `#1B7A4B` | `#5FD39B` |
| `--warning` 需要確認 | `#9C6200` | `#F0B75B` |
| `--danger` 目前不可修 | `#B3261E` | `#FF9A92` |
| `--info` 固定時段 | `#1C5FA8` | `#7FC3F0` |
| `--border` 裝飾用 | `#E4E2DC` | `#2A2F37` |
| `--border-strong` ≥3:1 | `#7E838D` | `#7A828E` |

**對比度（已計算，WCAG 2.1 相對亮度）**：所有內文配對 ≥4.5:1，所有 UI 邊界配對 ≥3:1。
關鍵幾組：`foreground`/`surface` **17.76:1** · `muted`/`surface` **6.39:1** · `accent`/`surface` **8.40:1** · 三個狀態 soft 配對 **6.62 / 7.47 / 7.55:1** · `field-border`/`surface` **3.81:1** · focus ring **7.77:1**。暗色全數 AAA。

**`--border`（1.30:1）是裝飾用，永遠不可作為控制項或課表格線的唯一邊界** —— 那些用 `--border-strong`。

**`--info` 不是 HeroUI 預設 token**，必須依 theming 文件手動新增並加 `@theme inline` 橋接。

### 4.3 修課資格狀態（修掉主色語意衝突）

每個狀態都帶 **圖示 + 文字 + 顏色** 三重通道，滿足「不可只用顏色傳達資訊」：

| 狀態 | token | Phosphor 圖示 |
|---|---|---|
| 條件已符合 | `success-soft` | `CheckCircle` |
| 需要確認 | `warning-soft` | `Question` |
| 目前不可修 | `danger-soft` | `Prohibit` |
| 衝堂 | `danger` 邊框 + 斜線紋理 | `Warning` |
| 固定時段（導師時間） | `info-soft` | `Lock` |

**課程類別標籤（本系必修/本系選修/通識/外系）不可重用語意色**，改用中性 chip + 4px 前導色條，取自獨立的「類別色階」。

### 4.4 字體

```css
--font-latin: "Inter var", "Inter", ui-sans-serif, system-ui, sans-serif;
--font-cjk: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei UI",
            "Noto Sans CJK TC", "Heiti TC", sans-serif;
--font-sans: var(--font-latin), var(--font-cjk);
```

**拉丁優先是刻意的**：瀏覽器逐 codepoint 解析，Inter 處理英數與標點（真 tabular figures），每個 CJK codepoint 落到 Noto Sans TC。
**選 Noto Sans TC 而非 SC/HK**：TC 用教育部標準字體字形，是台灣學生在課本與校方系統看到的骨架。也已經在用，是延續而非重寫。

**CJK 硬規則（修掉現有問題）**：
1. 所有含 CJK 元素 `letter-spacing: 0`。**刪掉 `h1{letter-spacing:-.04em}`** —— 負字距讓漢字筆畫相撞
2. 字重只准 **400 / 500 / 600 / 700**。刪掉 `650` `750` `900`（Noto Sans TC 無此實例，且 `font-synthesis:none` 擋掉合成，等於死 CSS）
3. `h1` 從 `clamp(2rem,4vw,3.4rem)`（最大 54px）降到 **`clamp(1.75rem,1.35rem+1.6vw,2.25rem)`**（最大 36px）—— 54px 漢字把整個篩選區推到摺線下
4. 任何內容文字最小 **15px**，絕對最小 13px（僅課表次要行）。**修掉 `.meta span{font-size:.78rem}`（12.5px）**
5. `overflow-wrap:anywhere` → `overflow-wrap:break-word; line-break:strict; word-break:normal`（CJK 仍自由換行，英文課名不再被從中切斷）
6. 保留 `font-synthesis: none`

### 4.5 元件對應（自訂 → HeroUI v3）

完整對應表在設計 agent 報告中。重點決策：

**系所選擇器用 `ComboBox`，不是 `Autocomplete`。**
HeroUI v3 的 `Autocomplete` 實作的是 ARIA **select** pattern（trigger 按鈕 + popover 內含 SearchField），trigger 裡沒有可編輯輸入框。`ComboBox` 才是 ARIA **combobox** pattern（`ComboBox.InputGroup > Input + Trigger`），正是現況與需求 —— 學生要打「圖資」「資工」「10」。
必要 props：`menuTrigger="focus"` · `allowsCustomValue={false}` · `defaultFilter` 直接復用 `departmentOptions.ts:209` 的 `filterDepartmentOptions` · `formValue="key"`。分組用 `ListBox.Section` + `Header`。

**課表格線 HeroUI 蓋不到，必須保持自訂。**
`ScheduleWorkspace.tsx:286` 的 grid 是 `72px repeat(N, minmax(150px,1fr))` × `44px repeat(M,72px)`，配 sticky 表頭與跨列絕對定位區塊。HeroUI `Table` 是 React Aria collection，**無法表達跨列區塊**，硬套會弄壞列印樣式與 roving tabindex。**只換配色 token，不重建結構。**

其他必須保持自訂的：skip link · `RouteFocusManager` · 課表 slot roving tabindex · `@media print` · 類別色階 · 衝堂斜線紋理。

### 4.6 動效（克制）

`ux` 領域把 `excessive-motion` 列為 High：每個畫面最多動 1–2 個元素。Magic UI 的 77 個元件中 **絕大多數是行銷用途，一律拒絕**（`border-beam` `meteors` `particles` `confetti` `marquee` 等）。

**只採用 3 個**：
1. **`blur-fade`** — 僅推薦結果卡片入場。**stagger index 上限 6**（總計 240ms），否則 30 筆結果要跑 1.2 秒。收緊參數到 `0.22s / 3px / 4px offset`
2. **`number-ticker`** — 只用在 `ExplorePage` 總數與 `DataPage` 統計。**不用在篩選計數**（每次按鍵都會變 → 持續動）。需兩處修補：拿掉硬編碼的 `text-black dark:text-white`；locale 從 `en-US` 改 `zh-Hant-TW`
3. **`animated-theme-toggler`** — 暗色切換。需兩處修補：改成寫 `data-theme` 屬性而非 `classList`；**圖示換成既有的 `@phosphor-icons/react`，不要引入第二套圖示庫**

**明確拒絕 `dot-pattern` 系列**：其原始碼每個點渲染一個 `<motion.circle>`，1200×400 的區塊在預設 16px 間距下 ≈ **1,900 個動畫 SVG 節點**。純 CSS `radial-gradient` 成本為零。

**`prefers-reduced-motion` 三層策略**：
1. 全域 CSS kill-switch（含 `::view-transition-*` 與 `--skeleton-animation: none`）
2. **JS 閘門** —— CSS `!important` **擋不住** `motion/react` 的 JS spring。用 `useReducedMotion()` hook 直接跳過整個 wrapper
3. HeroUI 原生逃生口：`Skeleton animationType="none"` · `Tooltip shouldSkipAnimation`

**只動 `transform` 與 `opacity`。不做 hover `scale()`**（會位移版面）。

---

## 5. 跨平台 / 手機介面（使用者明確要求，第一優先）

**手機不是「最後補 media query」，是每個 UI 任務的驗收條件。**

### 5.1 斷點：收斂成四個，mobile-first，不用 `max-width`，不用 `!important`

現況是 4 個重疊區間互相用 `!important` 打架（`.desktop-nav{display:none!important}`）。改成：

| 斷點 | min-width | 版面 |
|---|---|---|
| *(base)* | 0 | 單欄 · Drawer 導覽 · **篩選收進底部 Drawer** · 課表→單日列表 · 全寬按鈕 |
| `sm` | 640px | 卡片操作列內聯 · 2 欄統計 |
| `md` | 768px | 2 欄結果 · 內聯 tab 導覽（ScrollShadow）· 課表格線出現（可橫向捲動） |
| `lg` | 1024px | 篩選側欄 320px 與結果並排 · ExplorePage 改 Table · 課程詳情用右側 Drawer |
| `xl` | 1280px | 內容井上限 1200px · 課表五天免橫捲 |

用 `min-h-dvh`，**不用 `100vh`**。

### 5.2 手機上最關鍵的修正：篩選牆

現況 `RecommendPage` 有三個 `<details>` 篩選群組、每組 2 欄網格約 10 個控制項、還有第二層 `<details class="filter-advanced">` 巢狀。**手機上全部塌成單欄，從查詢框滾到第一張結果卡要 ~4 個螢幕。**

修法（具體）：
1. `lg` 以下整個篩選區移進 **`<Drawer placement="bottom">`**，加 `Drawer.Handle` 支援下拉關閉
2. 觸發器是右下 sticky 按鈕「篩選」+ `Badge` 顯示 `activeFilterCount`（`App.tsx:646` 已算好）
3. **已套用篩選的 `TagGroup` 留在頁面上、結果上方、永遠可見** —— 學生必須能不開任何東西就看到並移除條件
4. Drawer 內 `Accordion allowsMultipleExpanded={false}`（手機一次一組；桌機側欄才允許多開）
5. Drawer footer sticky：清除全部（ghost）+ 套用 N 項條件（primary）。**關閉時才套用，不是每次點擊都重排**
6. **手機上刪掉第二層 `filter-advanced` 巢狀** —— sheet 裡的兩層 disclosure 無法導航；進階選項平鋪到各組底部的單層 `Disclosure`

### 5.3 觸控與可讀性

- **觸控目標 44×44 最小，間距最小 8px**。HeroUI `size="md"` 是 40px → icon-only 按鈕與 `md` 以下的篩選 chip 要加 `min-h-11 min-w-11`
- 現有的 `.icon-button{min-width:44px;min-height:44px}` 與 `@media(max-width:800px){.choice-chip,.filter-choice,.filter-toggle{min-height:2.5rem}}` **已經做對了 —— 是移植，不是退步**
- 保留 `touch-action: manipulation`
- 手機內文底線 **16px**（現在 `.meta span` 是 12.5px）

### 5.4 課表在手機上

現況已有獨立的 `.mobile-schedule-list` 平行渲染（`ScheduleWorkspace.tsx:516`）+ `<select>` 選日 —— **但它與桌機格線重複了區塊 markup**。
重構時：抽出共用的 `<ClassBlock>` 元件供兩種版面使用；`<select>` 選日改成 `ToggleButtonGroup`（一~五在 44px 下剛好一排）。

### 5.5 驗收方式

**每個 UI 任務**都必須在 **375 / 768 / 1024 / 1440** 四個寬度實際檢查（用 chrome-devtools MCP 的 `resize_page` + `take_snapshot`），並且：

- 375px 下無橫向捲動（課表格線除外，它刻意可橫捲）
- 所有互動目標 ≥44×44
- 鍵盤可完整操作（含 Drawer 內）
- `emulate` 深色模式兩種都看過

---

## 6. 架構決策

### 6.1 目標目錄結構

現在是 **36 個檔案全平鋪在 `src/`，零 path alias**。

```
frontend/src/
├── main.tsx                    # entry：Providers 組裝
├── app/
│   ├── App.tsx                 # 只剩 shell（~80 行）
│   ├── routes.tsx              # 路由表 + React.lazy
│   ├── AppShell.tsx            # header / nav / footer / drawer
│   └── RouteFocusManager.tsx
├── pages/
│   ├── onboarding/  recommend/  explore/  schedule/  data/  assistant/
├── components/                 # 跨頁共用：CourseCard, EmptyState, StateAlert...
├── hooks/                      # useStore, useReducedMotion, useSchedulePlans...
├── data/                       # api.ts, db.ts, queries.ts（TanStack）
├── domain/                     # 純邏輯（現有 13 個模組原地搬入）
├── theme/                      # fju.css（token）, typography.css
└── styles.css                  # Tailwind entry + 剩餘自訂（目標 ≤120 行）
```

Path alias `@/*` 必須**同時**加在 `tsconfig.app.json`、`vite.config.ts`、**以及 `vitest.config.ts`** —— 後者是獨立 root config，**不繼承 vite config**（這也是為什麼測試現在沒吃到 `@vitejs/plugin-react`）。

### 6.2 領域層原則

**13/15 個領域模組已經是 100% 框架無關的純函式，零 React import。**（`search.ts:148` 的區域變數 `document` 是遮蔽命名，不是 DOM。）
只有 `db.ts` 碰 DOM（`indexedDB` / `window.dispatchEvent` / `crypto.randomUUID`），`api.ts` 碰網路。

**這層不動。** 重構的工作是把**藏在 UI 檔裡的邏輯搬出來**（T02），不是重寫已經正確的東西。

### 6.3 狀態架構要修的三件事

1. **`useStore` 的 O(N) IndexedDB 放大** —— `CourseCard` 每個實例各自訂閱 `completedCourses` 與 `favorites`（`App.tsx:973-974`）。25 筆結果 = **25 次獨立 IndexedDB 讀取同一個 store**，且每次 `fju-local-data` 事件都全部重讀。改成 provider 層單一訂閱 + context 下發。
2. **context 與 props 雙軌** —— `plans`/`activePlan`/`selectPlan` **同時**走 `SchedulePlanContext` 與明確 props；`ScheduleWorkspace` 完全不用 context。而 `profile` 兩者皆非，一路 prop drill 三層到 `CourseCard`。統一：兩者都走 context。
3. **三套並存的回饋機制** —— `FeedbackProvider` toast（`ui.tsx`）、`ScheduleWorkspace` 的 `.undo-toast`（:518）、`ManualCoursePanel` 的 `.notice`（:131）。統一到 HeroUI `Toast` + `ToastQueue`。

### 6.4 資料層（TanStack Query，只管 API）

**納入**：`getFacets` `getDepartmentCatalog` `getClassGroups` `getCourses` `getCoursesByIds` `lookupCourses` `getFeatures` —— 這些現在是 8 組各自為政的 `useState`+`useEffect`，其中 `App.tsx:565` 與 `:913` 是**逐字重複**且 `.catch(() => undefined)` **直接吞掉錯誤**。

**明確排除**：
- **`db.ts`** —— 那是本地可變使用者資料（個人設定、課表、備份還原），不是 server cache
- **`getCatalog` / `getEmbeddingBundle`** —— `api.ts` 已經有以 manifest sha256 為 key 的 IndexedDB 內容定址快取（`artifactCacheKey`），**對大型 artifact 比 Query 的記憶體快取更好**。套上去只會多一層快取而不移除舊的
- `embedQuery` / `askCourseAssistant` 是 POST → `useMutation`

現有 6 種拿取寫法中，只有 `ScheduleWorkspace.tsx:329` 的 `slotRequestRef` 單調遞增請求 ID 是**正確的過期回應防護**；其餘都有 race 或吞錯誤。

---

## 7. 風險與對策

| # | 風險 | 對策 |
|---|---|---|
| R1 | 改 `vite.config.ts` 在 dev 無效（B1） | **T00 最先做**，其他任何 config 變更之前 |
| R2 | 8 個 DOM 測試綁死 class 名（B2） | **T01 先把測試改成 role/accessible-name 查詢**，綠燈 commit，再動 production |
| R3 | CSS purge 靜默刪掉 runtime 組出的 class（B3） | Tailwind v4 自動掃描來源；**這 8 個 class 的樣式改用 data 屬性或 `@source inline(...)` 明確保留**，並在 T30 加一個 render 測試斷言狀態 chip 有正確視覺 token |
| R4 | 格式化 `styles.css` 產生觸及每行的 diff 且可能重排規則 | **不格式化它。** 只做「刪除死規則」與「新檔取代」；舊檔在 T43 整批刪除，不做中途美化 |
| R5 | 升級鏈綁成一包，一次動五個套件 | T10 單獨一個 commit，只做升級不改 UI；100 個測試 + tsc + build 是驗收 |
| R6 | React 19 ref callback 不可有隱式回傳值 | T10 內先 grep arrow-body ref callback；跑 `npx types-react-codemod@latest preset-19 ./src` |
| R7 | Vitest 4 的 `exclude` 預設只剩 `node_modules`/`.git` | T10 內設 `test.dir: "src"`，否則 build 後 `dist/` 會被掃進測試 |
| R8 | Vitest 4 `mockReset` 語義改變（改成還原原始實作） | `ScheduleWorkspace.test.tsx` 有 `vi.mock`，T10 內逐一確認 |
| R9 | `RouteFocusManager` 的單一 `<h1>` 契約已被違反 | T20 拆頁時修掉，並加測試釘住「每個路由恰好一個 h1」 |
| R10 | HeroUI Modal/Drawer 走 portal 到 `document.body`，列印樣式會漏 | T42 在 `@media print` hide-list 加 `[data-rac][role="dialog"]` |
| R11 | React Aria 內建字串是英文（「N results available」等） | **`<I18nProvider locale="zh-Hant-TW">`** —— 最常被漏掉的一步，T11 就要加 |
| R12 | 刪 `web_assets` 後後端 fallback 指向不存在目錄 | T03 同時改 `web.py:644` 的 `else` 分支：**明確報錯，不要靜默 fallback** |
| R13 | 部署路徑耦合：`Dockerfile:18` 寫死 `frontend/dist`、`web.py:645` 寫死 `dist/assets` | 不動 `outDir` 與 `base`。若動，Dockerfile 與 web.py 必須同步 |
| R14 | CI 無 lint / 無 bundle 預算 / **無 Docker build** | 本次不擴充 CI（scope 外），但 T42 手動跑一次 `docker compose build` 驗證 |
| R15 | production sourcemap 1.22MB 被公開 serve | T00 順手評估關掉或改 `hidden` |
| R16 | `pnpm install --frozen-lockfile` 是 CI 閘門 | 每次改 `package.json` 都要 commit 重生的 `pnpm-lock.yaml`；**Tailwind v4 的 `@tailwindcss/oxide` 有原生 postinstall，必須加進 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`**（現在只有 `esbuild`），且該檔已被 `Dockerfile:3` 複製 |

---

## 8. 驗收標準

**每一個任務結束時都必須全部成立**（使用者指定的品質底線）：

```bash
cd frontend
pnpm test          # 全綠（基線 100 個測試，只增不減）
npx tsc -b         # 0 錯誤
pnpm build         # 成功
```

加上：

- **無障礙不可退步** —— §3.5 清單逐項仍成立；新元件另須 `aria-label`（icon-only 按鈕、`Toolbar`、`Table.Content`）
- **手機驗收** —— §5.5 的四個寬度 + 亮暗兩色，用 chrome-devtools MCP 實際看過
- **可獨立合併** —— 每個 commit 都是能跑起來的狀態，不出現中間壞掉的大爆炸

最終（T43 之後）額外目標：

- `styles.css` ≤120 行（只剩 skip link、課表格線、class block、列印、forced-colors、reduced-motion）
- 單一檔案 ≤250 行
- 路由層級 code splitting（現在是單一 317kB chunk，零 `React.lazy`）
- 亮暗雙模式全頁面可用

---

## 9. 參考來源

- **codegraph MCP** —— 1,075 nodes / 2,673 edges，已於本次 session `codegraph init -i` 建立
- **npm registry API**（2026-08-24 實查）—— 所有版本號、`engines`、`peerDependencies`
- **heroui-react MCP** —— `list_components`（71 個元件）、`get_component_docs` ×40、`get_theme_variables`、`get_docs` theming/quick-start/frameworks
- **magicuidesign-mcp** —— `listRegistryItems`（77 個）、`getRegistryItem` w/ source：`blur-fade` `number-ticker` `animated-theme-toggler` `dot-pattern`
- **ui-ux-pro-max skill** —— `--design-system`、domains `ux` ×3 / `style` / `color` / `typography` / `web`、`--stack react`
- **context7 MCP** —— ⚠️ **配額用盡，本次未能使用**。套件資訊改以 npm registry + 官方文件替代並逐條標註來源
