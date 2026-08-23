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
- **專案路徑**：`/home/hyslchs/Course_Recommander_System`
- **本機監聽**：`127.0.0.1:8080`（未對外公開 8080，透過 Tunnel 反向代理存取）
- **應用技術**：FastAPI、SentenceTransformer (`intfloat/multilingual-e5-small`)、React SPA (Vite)

---

## 2. 環境變數設定 (`.env`)

`.env` 位於專案根目錄，權限建議維持 `600` (`chmod 600 .env`)。
需包含以下環境變數（**注意：請勿將 API 密鑰提交至版本控制**）：

| 變數名稱 | 說明 | 範例 / 預設值 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API 金鑰（用於 AI 助理功能） | `sk-...` |
| `FJU_QUERY_PLANNER_URL` | Query Planner API 端點 | `https://api.openai.com/v1/chat/completions` |
| `FJU_QUERY_PLANNER_MODEL` | Query Planner 模型 | `gpt-5-nano` |
| `FJU_QUERY_PLANNER_REASONING_EFFORT` | 推理強度 | `low` |
| `FJU_QUERY_PLANNER_MAX_COMPLETION_TOKENS` | 最大 token 數 | `800` |
| `FJU_QUERY_PLANNER_TIMEOUT_SECONDS` | 超時時間（秒） | `20` |

---

## 3. Docker Compose 操作指令

所有指令請在專案目錄下執行：

```bash
cd /home/hyslchs/Course_Recommander_System
```

### 啟動服務
```bash
docker compose up -d
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
docker compose down
```

### 重啟服務
```bash
docker compose restart
```

---

## 4. 重新建置與更新流程

當前端程式碼、後端邏輯或 artifacts 資料更新時，依以下步驟重新建置與部署：

```bash
cd /home/hyslchs/Course_Recommander_System

# 1. 重新建置 Docker 映像檔
docker compose build

# 2. 重新建立並無縫套用容器
docker compose up -d

# 3. 檢查容器狀態與健康度
docker compose ps
curl -s http://127.0.0.1:8080/health/ready
```

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

## 7. 資料備份與持久化

- **Runtime 記錄與資料庫**：掛載於主機的 `./data/runtime` 目錄（包含 `ai-usage.sqlite3` 等）。
- **備份指令**：
  ```bash
  # 備份 runtime 資料
  tar -czvf data_runtime_backup_$(date +%Y%m%d).tar.gz data/runtime/
  ```

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
若更新後發生未預期錯誤需回滾：
```bash
# 1. 檢視或還原程式碼變更
git checkout <PREVIOUS_COMMIT>  # 若有使用 git

# 2. 重新建置並啟動
docker compose build
docker compose up -d
```
