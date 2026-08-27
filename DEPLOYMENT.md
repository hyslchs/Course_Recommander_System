# Course Recommender System (CRS) 部署維護手冊

本文件說明輔仁大學課程推薦系統（Course Recommender System, CRS）在 Linux 主機上的正式部署架構、日常維護指令、備份與故障排查流程。

---

## 1. 系統架構

```
Internet (使用者)
       │
       ▼ (HTTPS / TLS 1.3)
Cloudflare Edge Proxy (DNS: crs.sixhuang.com)
       │
       ▼ (Cloudflare Tunnel: crs-linux-server / outbound only)
主機 cloudflared (systemd service)
       │
       ▼ (HTTP 127.0.0.1:8080)
Docker 容器 (crs-app / FastAPI + React SPA + SentenceTransformer)
```

- **公開網址**：`https://crs.sixhuang.com`
- **部署 worktree**：`/home/hyslchs/CourseRecommanderSystem-deploy`
- **本機監聽**：`127.0.0.1:8080`（未對外公開 8080，透過 Tunnel 反向代理存取）
- **應用技術**：FastAPI、SentenceTransformer (`google/embeddinggemma-300m`, CPU-only)、React SPA (Vite)

---

## 2. 環境變數設定 (`.env`)

`.env` 位於專案根目錄，權限建議維持 `600` (`chmod 600 .env`)。
需包含以下環境變數（**注意：請勿將 API 密鑰提交至版本控制**）：

| 變數名稱 | 說明 | 正式值／預設 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API 金鑰；只存在 `.env`，不進 image | （保留既有值） |
| `FJU_RECOMMENDER_ARTIFACTS_DIR` | 容器內 artifact 絕對路徑 | `/app/data/artifacts/1151-embeddinggemma-768` |
| `FJU_RECOMMENDER_CANONICAL_JSONL` | 容器內完整 canonical catalog 絕對路徑 | `/app/data/canonical/course_outlines_1151.jsonl` |
| `FJU_VERIFY_ARTIFACT_HASHES` | 啟用 manifest hash、尺寸與 index 驗證 | `1` |
| `FJU_EMBEDDING_DEVICE` | EmbeddingGemma 推論裝置 | `cpu` |
| `FJU_EMBEDDING_THREADS` | CPU inference 執行緒上限 | `8` |
| `HF_HUB_OFFLINE` | 啟動後禁止即時模型下載 | `1` |
| `FJU_AI_MODEL` | AI 助理模型 | `gpt-5.6-luna` |
| `FJU_AI_REASONING_EFFORT` | AI 推理強度 | `none` |
| `FJU_AI_MAX_OUTPUT_TOKENS` | AI 回覆 token 上限 | `1000` |
| `FJU_AI_MONTHLY_REQUEST_LIMIT` | 每月 provider call 上限 | `10000` |
| `FJU_AI_REQUESTS_PER_MINUTE` | 每個來源每分鐘請求上限 | `10` |
| `FJU_AI_TIMEOUT_SECONDS` | AI provider timeout | `25` |
| `FJU_AI_MODERATION_ENABLED` | 啟用 moderation | `1` |
| `FJU_AI_USAGE_DB` | AI usage DB（runtime volume） | `/app/data/runtime/ai-usage.sqlite3` |
| `FJU_ANALYTICS_ENABLED` | Analytics 開關；目前明確關閉 | `0` |
| `FJU_ANALYTICS_DB` | Analytics DB（runtime volume） | `/app/data/runtime/analytics.sqlite3` |
| `FJU_ANALYTICS_ADMIN_TOKEN` | 報表權杖；不建立、不更換 | （保留既有值） |

舊版 `FJU_QUERY_PLANNER_*` 變數先保留以避免影響既有環境；新版程式不再使用它們。舊的 model／reasoning／token／timeout 設定沒有完全一對一對應，已依 `.env.example` 採用新版安全預設；舊的 URL 不再需要，因 AI 助理使用 OpenAI SDK 與 `OPENAI_API_KEY`。

---

## 3. Docker Compose 操作指令

所有指令請在專案目錄下執行：

```bash
cd /home/hyslchs/CourseRecommanderSystem-deploy
```

### 啟動服務
```bash
# 正式更新請使用 deploy.sh；這裡僅保留已驗證 image 的手動啟動方式。
docker compose up -d --no-build
```

### 查看容器狀態
```bash
docker compose ps
```

### 查看即時日誌
```bash
# 查看最後 100 行日誌
docker compose logs --tail 100

# 持續跟隨日誌
docker compose logs -f
```

### 停止服務
```bash
docker compose stop
```

### 重啟服務
```bash
docker compose restart
```

---

## 4. 重新建置與更新流程

當前端程式碼、後端邏輯或 immutable artifact bundle 更新時，正式主機只使用以下流程：

```bash
cd /home/hyslchs/CourseRecommanderSystem-deploy
./deploy.sh
```

`deploy.sh` 依序執行：

1. `git pull --ff-only origin main`
2. immutable bundle lock、hash、canonical record count、dimension、index order 與 provenance 驗證
3. BuildKit named-context Docker build，將已驗證 artifacts 與 offline model bake 進 image
4. 以 source revision 建立獨立 Compose project，切換前只停止既有 running app container
5. Docker health、local live/ready 與 public ready 檢查

它要求 `.env` target 權限為 600；工作樹 dirty、bundle 缺失／驗證失敗或 health 失敗都會停止。
bundle 位於 Git 外部；若路徑不同，請設定 `CRS_ARTIFACT_BUNDLE_DIR`，不要把 artifacts 加回 Git。

---

## 5. 健康檢查 (Healthcheck)

### 本機端點檢查
```bash
curl -s -i http://127.0.0.1:8080/health/ready
```
預期回應 `HTTP/1.1 200 OK`，JSON 包含 `{"status":"ready", ...}`。

### 公開網址端點檢查
```bash
curl -s -i https://crs.sixhuang.com/health/ready
```

---

## 6. Cloudflare Tunnel 維護

本專案使用 Remotely-Managed Cloudflare Tunnel：
- **Tunnel 名稱**：`crs-linux-server`
- **服務名稱**：`cloudflared.service`
- **Public Hostname 路由**：`crs.sixhuang.com` -> `http://localhost:8080`

### 常用管理指令
```bash
# 查看 service 狀態
systemctl status cloudflared

# 重啟 cloudflared
sudo systemctl restart cloudflared

# 停止 / 啟動
sudo systemctl stop cloudflared
sudo systemctl start cloudflared

# 查看 cloudflared systemd 日誌
sudo journalctl -u cloudflared -n 50 -f
```

---

## 6.1 用 Cloudflare Access 保護分析端點

`FJU_ANALYTICS_ADMIN_TOKEN` 認的是「誰持有這串字」，不是「誰是你」。
若要綁定真實身分，可在 Cloudflare Zero Trust 的邊緣再加一層 Access。
兩者可並存，且**建議並存**：Access 擋在網路邊緣，token 擋在應用層。

### ⚠️ 先讀這一段，否則會靜默弄壞全站統計

三個分析路徑共用同一個前綴，但**用途完全相反**：

| 路徑 | 誰在呼叫 | 必須 |
|---|---|---|
| `POST /api/v1/analytics/events` | **每一位學生的瀏覽器** | **保持公開** |
| `GET /api/v1/analytics/report` | 只有你 | 保護 |
| `GET /api/v1/analytics/dashboard` | 只有你 | 保護 |

如果建立一條涵蓋 `api/v1/analytics` 整個前綴的 Access 政策，學生瀏覽器送出的
統計事件會在邊緣被擋下並導向登入頁。前端的 `fetch` 會因跨網域重新導向而失敗，
連續數次後前端斷路器會關閉該分頁的統計——**沒有任何錯誤訊息，網站看起來完全正常**，
只有儀表板從此不再有新資料。

因此下面刻意建立**兩個各自指向完整路徑的應用程式**，而不是一個前綴。

### 步驟

前置：Zero Trust Dashboard（`one.dash.cloudflare.com`）已存在，
因為 `crs-linux-server` 就是 Remotely-Managed Tunnel。Team domain 也已建立。

**1. 確認登入方式**

`Settings → Authentication → Login methods`。預設已啟用 **One-time PIN**
（輸入 Email 收驗證碼），單一管理者用這個即可，不需要任何額外設定。

若要改用 Google 登入，需先到 Google Cloud Console 建立 OAuth 用戶端，
授權的重新導向 URI 填 `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`，
再回到此頁 `Add new → Google` 填入 Client ID 與 Secret。

**2. 建立第一個應用程式（報表 API）**

`Access → Applications → Add an application → Self-hosted`

| 欄位 | 值 |
|---|---|
| Application name | `CRS Analytics Report` |
| Session duration | `24 hours` |
| Subdomain | `crs` |
| Domain | `sixhuang.com` |
| Path | `api/v1/analytics/report` |

政策：`Action = Allow`，`Include → Emails → <你的 Email>`。

**3. 建立第二個應用程式（儀表板頁面）**

同上，唯二不同：

| 欄位 | 值 |
|---|---|
| Application name | `CRS Analytics Dashboard` |
| Path | `api/v1/analytics/dashboard` |

兩個都要保護。只保護 `report` 的話，儀表板頁面本身打得開，
但它內部的 `fetch` 會拿到登入頁的 HTML 而不是 JSON，畫面上只會出現一個看不懂的解析錯誤。

**4. 驗收（兩項都要做）**

```bash
# (a) 報表已受保護：未登入應得到 302，導向 cloudflareaccess.com
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://crs.sixhuang.com/api/v1/analytics/report

# (b) 統計蒐集未被波及：必須是 202，不是 302
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://crs.sixhuang.com/api/v1/analytics/events \
  -H 'Content-Type: application/json' \
  -d '{"events":[{"event":"page_view","data":{"page":"recommendation"}}]}'
```

(b) 若不是 `202`，代表 Access 政策把 ingest 路徑一起蓋住了，請回頭檢查 Path 欄位是否
誤填成 `api/v1/analytics`。

最後用無痕視窗開 `https://crs.sixhuang.com/api/v1/analytics/dashboard`，
應先出現 Cloudflare 登入頁，通過後才看到儀表板，再貼上 `FJU_ANALYTICS_ADMIN_TOKEN`。

### 用指令列讀報表（選用）

Access 擋掉的不只是瀏覽器。若要用 `curl` 或排程讀報表，需建立 Service Token：

1. `Access → Service Auth → Create Service Token`，記下 Client ID 與 Secret（只顯示一次）。
2. 回到 `CRS Analytics Report` 應用程式，新增一條政策：
   `Action = Service Auth`，`Include → Service Token → <剛建立的>`。

```bash
curl -s https://crs.sixhuang.com/api/v1/analytics/report \
  -H "CF-Access-Client-Id: <client-id>" \
  -H "CF-Access-Client-Secret: <client-secret>" \
  -H "X-Analytics-Token: <FJU_ANALYTICS_ADMIN_TOKEN>"
```

三個標頭缺一不可：前兩個過 Cloudflare 邊緣，第三個過應用層。

---

## 7. 資料備份與持久化

- **Runtime 記錄與資料庫**：掛載於主機的 `./data/runtime` 目錄（包含 `ai-usage.sqlite3`、`analytics.sqlite3` 等）。
- **備份指令**：
  ```bash
  # 備份 runtime 資料
  tar -czvf data_runtime_backup_$(date +%Y%m%d).tar.gz data/runtime/
  ```

---

## 7.1 使用統計（Analytics）維護

統計資料庫為 `data/runtime/analytics.sqlite3`，由應用程式自行維護：

- **保存期限**：容器啟動時強制執行一次，之後最多每 15 分鐘隨流量再執行一次。
  無需 cron。過期的原始事件會被刪除，`session_id` 與 `interaction_id` 在 7 天後
  被清空，每日彙總表則長期保留。
- **查看報表**：先在 `.env` 設定 `FJU_ANALYTICS_ADMIN_TOKEN`，重新啟動後開啟
  `https://crs.sixhuang.com/api/v1/analytics/dashboard`，於頁面輸入權杖。
  該頁面本身不含任何資料；資料來自需要權杖的 `/api/v1/analytics/report`。
- **關閉統計**：設定 `FJU_ANALYTICS_ENABLED=0` 並重啟。前端不需要改動——
  接收端點仍會回應 202 並直接丟棄。
- **隱私注意事項**（與 `/privacy` 頁面內容一致，修改任一處時請同步）：
  - 應用程式的統計事件**不含 IP**，資料表也沒有該欄位。
  - uvicorn 以 `--no-access-log` 啟動，因此容器不會寫出含 IP 的存取紀錄。
  - Cloudflare Tunnel／Cloudflare Edge 仍可能保有其自身的連線紀錄（含 IP）。
    這一層不在本系統控制範圍內，`/privacy` 頁面已據實說明，請勿改寫成
    「完全不會留下任何 IP」。

---

## 8. 安全與開機自啟驗證

### 1. 確認未公開 8080 連接埠
```bash
# 檢查監聽位址應為 127.0.0.1:8080
ss -tulpn | grep 8080

# 測試以外部 IP 連線（應無法連通）
curl -s --connect-timeout 3 http://140.136.153.101:8080
```

### 2. 開機自動啟動驗證
- **Docker 容器**：`compose.yaml` 中配置 `restart: unless-stopped`，Docker daemon 啟動時自動帶起容器。
- **Cloudflared 服務**：已啟用 systemd 服務開機自啟（`systemctl is-enabled cloudflared` 為 `enabled`）。

---

## 9. 故障排查與回滾

### 症狀 1：網頁出現 502 Bad Gateway
1. 檢查 Docker 容器是否運行：`docker compose ps`
2. 若容器未啟動：`docker compose up -d`
3. 檢查容器內部錯誤日誌：`docker compose logs --tail 50`

### 症狀 2：網頁無法解析或連線逾時
1. 檢查主機 `cloudflared` 狀態：`systemctl status cloudflared`
2. 若服務異常，重啟服務：`sudo systemctl restart cloudflared`
3. 至 Cloudflare Zero Trust Dashboard 確認 Tunnel `crs-linux-server` 狀態為 Healthy。

### 症狀 3：回滾至前一版本
回滾不修改 Git 工作樹，也不刪除舊 image、container 或 volume。

`deploy.sh` 在切換後 health 失敗時會保留新失敗 container，並嘗試啟動切換前
仍在運作的 app container。

若需手動回滾，先確認目標 container ID，再只執行 stop／start：

```bash
docker ps -a --filter 'label=com.docker.compose.service=crs-app'
docker stop <current-container-id>
docker start <previous-container-id>
curl --fail http://127.0.0.1:8080/health/ready
```
