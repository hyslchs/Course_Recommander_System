# 複合課程搜尋評估資料

這個資料夾包含兩種不同用途的測試資料：

- `manual_test_cases_v1.csv`：給人閱讀、逐筆輸入與記錄結果，可以用 Excel、Google Sheets 或一般文字編輯器開啟。
- `manual_test_cases_v1.json`：給程式或 AI 讀取，欄位較完整。
- `compound_queries_v1.json`：160 筆尚未完成人工審核的評估草稿，不可直接當成正式相關性標註。

## 人工測試集欄位

CSV 的每一列是一個測試案例：

| 欄位 | 說明 |
|---|---|
| 編號 | 測試案例識別碼 |
| 類型 | SINGLE、COVERAGE、INTERSECTION、否定／硬條件等 |
| 查詢內容 | 要貼到系統搜尋框的文字 |
| 功能旗標 | `on`、`off` 或 `both` |
| 預期關係 | SINGLE、COVERAGE、INTERSECTION、FILTER_ONLY 或 FALLBACK |
| 預期目標／情境／排除 | 系統應辨識的查詢片段 |
| 硬條件 | 星期、學分、節次、類別等可驗證條件 |
| 預期結果檢查 | 前 10 筆結果應符合的規則 |
| 人工備註 | 測試人員填寫實際觀察結果 |

## 建議測試流程

### 1. 測試原本的搜尋基線

先關閉複合查詢功能：

```powershell
$env:FJU_COMPOUND_QUERY_ENABLED = '0'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
fju-outline-web --artifacts-dir data/artifacts/1151 --port 8080
```

確認 `/api/v1/features` 回傳 `compound_query_enabled: false`，先測試 CSV 中 `SINGLE` 與功能旗標為 `off` 的案例，確認不會顯示理解面板且單一目標排名沒有明顯改變。

### 2. 測試複合搜尋功能

重新啟動服務，改成：

```powershell
$env:FJU_COMPOUND_QUERY_ENABLED = '1'
fju-outline-web --artifacts-dir data/artifacts/1151 --port 8080
```

接著測試 COVERAGE、INTERSECTION、否定、硬條件、不可回答與邊界案例。

每一筆案例都記錄：

1. 關係是否符合「預期關係」。
2. 目標、情境、排除與條件標籤是否正確。
3. 前 10 筆是否全部符合課程欄位硬條件。
4. COVERAGE 是否涵蓋各個目標。
5. INTERSECTION 是否找到共同符合課程；找不到時是否顯示部分符合警告。
6. FALLBACK 是否顯示不支援或資料限制，而不是假裝已正確理解。
7. 課程本身是否真的符合學生需求。這一項需要人工判斷。

### 3. 代表性案例

| 查詢 | 預期結果 |
|---|---|
| `資料庫＋後端` | COVERAGE；前 10 名應涵蓋資料庫與後端 |
| `企業法務實習` | INTERSECTION；辨識法律目標與實習情境 |
| `不要星期三的通識` | FILTER_ONLY；結果不得在星期三且必須是通識 |
| `Python 或 R` | FALLBACK；顯示目前不支援替代關係 |
| `甜課` | 顯示資料限制，不產生看似精確的推薦 |
| `想學 AI 但要甜涼` | 搜尋 AI，同時說明甜涼條件沒有套用 |

## 交給 AI 測試

AI 可以讀取 `manual_test_cases_v1.json`，逐筆比對 `expected_analysis`、`hard_constraints` 與 `expected_result_checks`。但 AI 不應自行把推薦課名標成正式相關課程；課程相關性仍需人工覆核。

目前查詢分析是在瀏覽器前端執行，因此 AI 若要自動操作完整流程，需要使用瀏覽器測試工具；後端 API 主要可直接測試批次向量、功能旗標與情境 route 檔案。

## 160 筆評估草稿

如需重新產生尚未核准的 160 筆 draft：

```powershell
python -m fju_outline.cli evaluation-draft
```

資料分為 development 100 筆、validation 30 筆與 hidden test 30 筆。只有人工補上課程證據並將 `review.approved` 設為 `true` 後，才可以作為正式發布門檻的一部分。
