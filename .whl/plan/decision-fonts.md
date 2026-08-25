# 決策：字體策略（T41b 執行依據）

量測完成於 2026-08-25，原型與數據在 `/tmp/fontlab/`。**repo 未被改動。**

## 結論：走自行子集化，但**不是計畫原本寫的那種**

計畫 §T41 option (c) 寫的是「對 5,179 個語料碼位打包」。**這個寫法不安全，不可以照做。**

### 為什麼 naive 子集化會出事
語料數字本身是對的（重新掃出 5,183，與 T12 的 5,179 相符）。但真正該看的是**開放語料風險**：
方案名稱輸入（`pages/schedule/ScheduleWorkspace.tsx:419`，`maxLength={80}`）與 AI 小幫手（`web.py:700`，任意散文）都是自由文字。

以 Big5 常用字（5,495 字）為基準實測涵蓋率：

| | Big5 L1 涵蓋率 |
|---|---|
| 目前出貨的字體 | **99.6%** |
| 只含語料的子集 | 68.9%（**少掉 1,687 個常用字**） |
| 只含名稱/UI 的子集 | 30.9% |

學生打一個普通的中文方案名稱，就有相當機率撞到缺字。**不要對語料子集化。**

## 採用的做法：三層家族，涵蓋率完全不變

229 kB 的來源是 **`unicode-range` 字串，不是字形** —— 329,960 bytes 的十六進位。
把 fontsource 每個字重的 105 個切片用 `fontTools.merge` 併回單一 TTF（**保留 GSUB/GPOS/GDEF/BASE**），再切成三層、宣告成三個 family：

- `FJU Sans 1` — 1,921 碼位：課名/系所/教師/meta + 全部 UI chrome
- `FJU Sans 2` — 4,442 碼位：其餘 app 語料（課綱內文）∪ Big5-L1 剩餘
- `FJU Sans 3` — 5,790 碼位：字體裡剩下的全部

`font-family` 三層串接，**12 條 `@font-face`，零 `unicode-range`**。涵蓋率與今天完全相同。

## 量測結果

伺服器實況：`web.py:314` 是 `GZipMiddleware`（**無 brotli**），所以今天 CSS 的實際傳輸量是 **246,820 B**，不是 229 kB。

| | 現況 | (a) 非阻塞 | (b) 砍字重 | **(c) 三層** |
|---|---|---|---|---|
| CSS gzip | 250,936 | 36,924 + 210,062 async | 144,902 | **37,298** |
| render-blocking（實際傳輸） | 242 kB | 39 kB | 145 kB | **39 kB** |
| `@font-face` 條數 | 420 | 420 | 210 | **12** |
| dist（不含 .map） | 10.97 MB / 433 檔 | 10.86 MB / 431 | 6.08 MB / 228 | **9.02 MB / 39 檔** |
| Docker layer (`du`) | 12M | 12M | — | **8.7M** |

冷載 `/explore`：Slow 4G FP 3104 → **1556 ms**、FCP 3612 → **2224 ms**、總量 1678 → **1522 kB**。
單次 session 走完五頁：2,267.7 kB → **1,587.8 kB（−30%）**，且 (c) 有上限，現況會一路長到 8.65 MB。

**保真度精確**：advance width 與現況完全相同（Latin 1347.11 / 數字 555 / 漢字 1700），文件高度相同，截圖差異 1.06% 畫素中只有 **65 個**差距 >128（次感知級抗鋸齒）。保留 GSUB/GPOS 只多 2.7% 體積但**必要** —— 拿掉會讓有 kerning 的拉丁文字變寬 2.3%。

## 被實測否決的選項

**(b) 砍字重不可行。** 500 與 600 是活的：bundled CSS + 出貨 JS 靜態分析找到 **25 個 class 用 500**（`button`/`badge`/`chip`/`tabs__tab`/`table__column`/`card__title`/`modal__heading`/`toast__title`/`label`/`pagination__link`…）、6 個用 600，瀏覽器實測 `/explore` 有 66 個元素以 500 渲染。砍掉會讓 T34 做的表頭從 Medium 塌回 Regular，也牴觸計畫 §4.4-2。

## Inter：刪掉，不要裝

在執行中的 app 再次驗證：`--font-sans` 計算結果是**空字串**，實際生效的是舊 CSS `styles.css:239` 的 `"Noto Sans TC","Segoe UI",sans-serif`；用 `"Inter var","Inter"` 排的探針量到 **1002.69 px，與不存在的字體名、與 `serif` 完全相同**。

計畫選 Inter 的理由（真 tabular figures）**從二進位讀出來就是錯的**：十個數字全部 advance 555/1000 em，而且出貨的拉丁切片 GSUB 只有 `ccmp, liga, locl, vert, vrt2` —— **根本沒有 `tnum`**，`font-variant-numeric: tabular-nums` 沒有東西可以啟動。數字本來就等寬。

## 🔴 順帶發現：OFL 條款 2 目前未履行

OFL-1.1 明文允許 merge/modify/redistribute（Noto Sans TC 無 Reserved Font Name，nameID 0 裡的 `Reserved Font Name 'Source'` 是 Source Han 血統遺留，只保留 "Source"），子集化合法。

**但條款 2 要求每份副本都要附上版權聲明與授權**，而 `dist/` 今天**沒有任何授權檔**，fontsource 二進位的 nameID 13 是空的。`pyftsubset` 還會再丟掉 nameID 14（OFL 網址）。
T41b 必須加 `--name-IDs='*'`，並把 `node_modules/@fontsource/noto-sans-tc/LICENSE` 複製到 `dist/assets/fonts/OFL.txt`。**這是既有缺失，不是新增的。**

## 工具鏈（已實跑驗證，非推測）

- `fonttools 4.63.0` + `pyftsubset` 本機已有。
- **CI 免費**：`.github/workflows/ci.yml` 已經在 `pnpm build` 之前跑 `actions/setup-python@v5`（3.11），加一行 `pip install fonttools brotli` 即可。
- **Docker 可行**（在 `node:24.15-alpine` 內實跑過整套 merge+subset）：`apk add --no-cache python3 py3-pip py3-brotli` + `pip install --break-system-packages fonttools`（brotli 必須走 apk，musl 無 wheel）。只增加 **builder** stage 約 80 MB，會被丟棄；`Dockerfile:18` 只複製 `dist/`。**runtime image 淨減 3.3 MB / 394 個檔案**，build 時間 +約 150 秒。
- ⚠️ **陷阱**：frontend stage 只 `COPY frontend/`，`data/` 不在裡面。所以三份碼位清單要 commit 進版控（85 kB，gzip 29 kB），build 讀檔；CI 重新產生並 `git diff --exit-code` 做 drift 檢查。
- 純 JS 路徑（`subset-font`，harfbuzz-wasm）**無法 merge**，而 merge 正是需要 fontTools 的那一步。

## 接受的取捨

**粒度變粗。** 開一份課綱只需要 25 個 tier-2 碼位，卻要拉整層：4 份課綱 **2,099.6 kB vs 現況 786.3 kB**。但這是一次性、可快取、有上限的（開到 20 份時 (c) 仍是 2,099.6 kB，現況已爬到 1,303 kB 且繼續長）。**第一次冷開課程詳情約比今天重 2 倍。** 若不接受，把 tier2 再切一半即可 —— 多 4 條規則、約 0.5 kB CSS。

## 若 (c) 在 CI/Docker 被擋

**退回 (a) 單獨使用**（原型在 `/tmp/fontlab/a`，約 30 行 `transformIndexHtml` plugin + `rel=preload`/`onload` 切換 + `<noscript>`）：無新相依、涵蓋率不變、阻塞 CSS 242 → 39 kB、Slow-4G FP 3104 → 1728 ms —— 拿到 (c) **88% 的首繪收益，但只有 34% 的 FCP 收益**，且 dist 仍是 433 檔 / 12 MB。
第二退路：仍走 (c)，但把 12 個產生出來的 woff2（7.67 MB）commit 進版控 + CI drift 檢查，build 就完全不需要 Python。

## 另一個與字體無關的免費收益

`sourcemap: "hidden"` 會吐約 **4.7 MB 的 `.map`** 進 `dist/`，而 `Dockerfile:18` 把它們整包複製進 runtime image。**這比整個字體決策省下的還多。** T41b 或 T42 順手處理。
