# pi-agent image

供 PaaS 平台 cloud service 使用的 **pi coding agent（pi-web）** image。

- Registry：`jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent:{tag}`（tag = UTC `YYYYMMDD.HHMM`，走候選 tag → 核可 → promote）
- 平台側 **pin image digest**；chart 為 `woow-paas-charts` 的 `charts/pi-agent`。
- 上游：`WOOWTECH/Woow_k3s_pi_agent_package`（Gitea 鏡像 `woow-paas/Woow_k3s_pi_agent_package`），其 GitHub Actions 發佈 `ghcr.io/woowtech/woow-k3s-pi-agent:<semver>`。本 image **以 digest 消費上游**，不重建 pi-web。

## 這顆 image 改了什麼（相對上游 0.2.4：pi-web 0.12.0）

| # | 改動 | 為什麼 |
|---|---|---|
| 1 | `/api/models-config` 回傳的 `providers.*.apiKey` 遮罩成 `__PI_REDACTED__:<末 4 碼>`；PUT 回寫時遇到遮罩值就還原磁碟上的原值 | 上游把 provider key 原樣回給瀏覽器（READINESS.md B3）。瀏覽器只是把它塞回 `<input>`，不需要真值 |
| 2 | 以 uid/gid **1000** 執行；`pi-web-start.sh` 的兩行 `/etc/localtime`、`/etc/timezone` 改為 best-effort | 上游是 root。腳本 `set -e`，非 root 寫 `/etc` 會直接讓容器起不來；Node 本身讀 `TZ` env，不靠 `/etc` |
| 3 | `VIDEO_PIPELINE_ENABLED=false`、`PI_WEB_HOSTNAME=127.0.0.1` 預設 | 影片工具鏈（720MB、Chromium）租戶版不提供；pi-web 只綁 loopback，由 chart 的 nginx sidecar 擋 Basic auth |
| 4 | omnigent CLI 0.16.0：`omnigent-requirements.lock`（`uv pip compile --generate-hashes`，94 個套件全釘版＋hash）以 `uv pip sync --require-hashes` 裝進 `/opt/omnigent/venv`，CPython 釘 3.12.14（uv 管理，uv 本身驗 release sha256、裝完不留）、建置時編好 bytecode（`UV_COMPILE_BYTECODE=1`）；`/usr/local/bin/omnigent`；`OMNIGENT_CONFIG_HOME`／`OMNIGENT_DATA_DIR` = `/data/pi-agent/home/.omnigent`；遙測關閉（`OMNIGENT_ANALYTICS=0`、`DO_NOT_TRACK=1`、`DISABLE_TELEMETRY=1`）；刪掉 Claude Agent SDK 自帶的 200 MB `claude`；`/etc/bash.bashrc` 載入 `omnigent-terminal.sh` | 讓 pi-agent 能當 Omnigent 的機器（host）：租戶在 pi-web 終端機 `omnigent login <omnigent 網址>`，chart 的 omnigent-host kit 在 **pi-web 容器裡**背景執行 supervisor（tini → launcher → pi-web-start.sh，沒有 sidecar），自動上線、重啟後自己回來。**launcher／supervisor／guard 都不在 image 裡**，由 chart 從 woow-paas-charts `shared/omnigent-host`（共用套件，ConfigMap）帶進來；image 只提供 omnigent CLI、tmux ≥ 3.3（基底 Debian 12 的 3.3a，基底以 digest 釘住）、flock／setsid。設定目錄就是原本手動安裝用的 `~/.omnigent`（HOME 在 volume 上），既有 host 的 host_id 與登入原樣沿用。終端機 hook：載入 kit 的 profile（kit bin 回到 PATH 最前面），`omnigent`／`omni` 一律走 kit 的 guard 再到 image 的 CLI（PVC 上手動裝的舊版蓋不過去；supervisor 在跑時第二個 `omnigent host` 會被明確拒絕），每個終端機在租戶需要動手時印一次狀態與登入指令。本 image 沒有 Claude Code，經 Omnigent 用的是 Pi harness |

| 5 | 文件工具：`python`（python-is-python3）、python3-docx、python3-openpyxl、python3-pypdf、python3-reportlab、poppler-utils、fonts-wqy-microhei（Debian 12 套件，版本釘死） | QA round 1 PA-02：pi 處理 Word／Excel／PDF 時沒有工具可用。中文 PDF：基底的 Noto CJK 是 CFF 字型，reportlab 不能嵌入（postscript outlines are not supported），所以另裝 TrueType 的文泉驛微米黑（`/usr/share/fonts/truetype/wqy/wqy-microhei.ttc`）。reportlab 內建的 CID 字型（例如 MSung-Light）不會嵌入，沒有中文字型的閱讀器和 pdftotext 都讀不出來，不要用。build 驗證用 `doc-tools-check.py` 實際產生並讀回 docx／xlsx（含公式）／pdf（含嵌入文泉驛字型的繁中 PDF：pypdf、pdftotext 讀回，pdffonts 顯示已嵌入） |

| 6 | 沒有模型或 provider 金鑰時按「傳送」：`/api/agent/new`、`/api/agent/[id]` 的錯誤文字改成「尚未設定模型：請點左下角「模型」，登入供應商（OAuth）或填入 API 金鑰……（No API key found for the selected model.）」；回應形狀不變（500、`code: prompt_rejected`、`accepted: false`，訊息照樣退回輸入框）。只改 pi 的三種訊息（No API key found／No model selected／No models available），其他錯誤原樣 | #1357：pi 原文是英文、叫租戶打 TUI 的 `/login`、還附兩個 `node_modules` 絕對路徑，pi-web 只用 5 秒 toast 顯示，租戶以為服務沒反應 |
| 7 | 上游首次啟動自動註冊的 Shared Runtime：Pi Web 安裝的 skills 與全域 MCP 會提供給 Claude Code、Codex；官方 CLI 已在映像內 | 新租戶不必另行下載 CLI 或手動安裝共享套件。Pi plugin／extension 是 Pi 專用程式碼，不跨代理載入；登入與帳號憑證仍由使用者完成 |

patch 用**精確錨點**（`patch-models-config.mjs`、`patch-prompt-errors.mjs`），錨點數 ≠ 1 就讓 build 失敗——pi-web 升版搬了程式碼時會被擋下，不會靜默漏 patch。

## 升上游版本

改 `Dockerfile` 的 `ARG BASE=…@sha256:…`（index digest，`docker manifest inspect ghcr.io/woowtech/woow-k3s-pi-agent:<ver>` 取得），重跑 build；patch 錨點若不再吻合，到 `pi-web` 新版的 `.next/server/app/api/models-config/route.js`、`.next/server/app/api/agent/{new,[id]}/route.js` 重新對錨點。

- 0.2.1 → 0.2.2（2026-10-03，#1357）：pi-web 0.9.0 → 0.10.0（pi 0.85.1 → 1.0.0）。0.10.0 的 models-config GET 多包了 try/catch，GET 錨點改成 `async function h(){try{return …`；寫入端是 PUT（anchor 形狀不變）。

## omnigent（第 4 步）

- **升 omnigent 版本**：改 `omnigent-requirements.in`，在本目錄重跑 lock 檔開頭註解裡的 `uv pip compile … --generate-hashes` 指令（Python 3.12、`x86_64-manylinux_2_36`），把註解補回去，再改 Dockerfile 的 `OMNIGENT_VERSION`。build 的驗證步驟會比對「已安裝套件＝lock」，多一個、少一個或版本不同都會失敗。
- **launcher、supervisor、guard、狀態訊息**：在 woow-paas-charts `shared/omnigent-host/`（README 有完整行為與 env 契約），chart 以 ConfigMap 掛到 pi-web 容器的 `/etc/omnigent-host`；image 不放任何 supervisor（舊的 `omnigent-host-supervisor.sh` 已移除）。
- **租戶看得到的狀態**：pi-web 終端機是 `bash -l`，Debian 的 `/etc/profile` 會載入 `/etc/bash.bashrc` → `/etc/woow/omnigent-terminal.sh` → `omnigent-host-status --motd`（未登入、登入失效、需要 `omnigent host reset-id` 等情況才印，含正確的登入指令）。隨時可執行 `omnigent-host-status` 看完整狀態。
- **驗證**（`build-pi-agent-image.yml`）：omnigent 版本、Python 3.12.14、lock 一致、omnigent 套件每個 `.py` 都有 `.pyc`、SDK 目錄存在且其下沒有 >10 MB 的檔（不再是 `test ! -e "$(find …)"` 這種找不到也會過的空測）、image 裡沒有 supervisor、tmux ≥ 3.3、flock／setsid、`/usr/bin/tini` 存在且可執行（chart 0.1.4 把它寫死成 pi-web 的 PID 1，kit 停用時也一樣；BASE 升版拿掉它會讓 pod CrashLoop，所以在這裡擋）、omnigent shebang 的 python 能 import yaml（kit 的 OG_PYTHON）、終端機 hook（kit 掛載時 omnigent／omni 走 guard 且 guard 先找到 image 的 CLI、MOTD 只印一次；沒有 kit 時安靜）、文件工具實際產生並讀回 docx／xlsx／pdf。

## 本地驗證

```bash
docker build -f pi-agent/Dockerfile -t pi-agent:dev pi-agent
docker run --rm pi-agent:dev id                                   # uid=1000
docker run --rm -d --name p -e TZ=Asia/Taipei -v $(mktemp -d):/data/pi-agent pi-agent:dev
docker exec p sh -c 'printf "{\"providers\":{\"x\":{\"apiKey\":\"sk-secret-1234\"}}}" > /data/pi-agent/models.json'
docker exec p curl -s -H "Host: localhost" http://127.0.0.1:30141/api/models-config   # apiKey = __PI_REDACTED__:1234
```

## ChatGPT OAuth 安裝身分修正

Pi Web OAuth route 傳入 `getDeviceId`。UUID 由 SDK `SettingsManager.getOrCreateDeviceId()` 寫入持久化的全域 agent settings；不使用 project 身分、不複製其他安裝的 UUID 或登入憑證。build 執行 route-anchor 回歸與真實 SDK 跨程序 UUID 驗證，upstream anchor 改變時建置失敗。使用者仍需自行完成 ChatGPT OAuth 授權。

## 新開通預裝 CLI

官方 Claude Code 2.1.296 與 Codex 0.162.1 在 image build 以 npm lockfile 安裝到 /opt/pi-clis，/usr/local/bin 提供可執行入口。一般 uid1000 與新 HOME 的 --version 於 CI 驗證。新服務不用下載 CLI；Shared Runtime 會偵測已有安裝而跳過。登入、訂閱、API key 與 workspace 均由使用者設定，不把任何帳號或 token 打包進映像。既有 PVC 自行安裝版本不覆蓋。

## Skills 與 MCP 共用

首次啟動會在空白的 Pi 資料卷註冊映像內的 Shared Runtime，且不會建立對話或送出模型請求。Pi Web 安裝的 skill 會以符號連結供 Claude Code 與 Codex 使用；Pi Web 的全域 MCP 會經受控 bridge 提供給兩個 CLI。使用者自行移除 runtime 或原本就設定外部 runtime 時，啟動流程會保留該選擇。Pi plugin／extension 不會跨代理同步。
