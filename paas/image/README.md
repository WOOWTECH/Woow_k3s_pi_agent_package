# pi-agent image

供 PaaS 平台 cloud service 使用的 **pi coding agent（pi-web）** image。

- Registry：`jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent:{tag}`（tag = UTC `YYYYMMDD.HHMM`，走候選 tag → 核可 → promote）
- 平台側 **pin image digest**；chart 為 `woow-paas-charts` 的 `charts/pi-agent`。
- 上游：`WOOWTECH/Woow_k3s_pi_agent_package`（Gitea 鏡像 `woow-paas/Woow_k3s_pi_agent_package`），其 GitHub Actions 發佈 `ghcr.io/woowtech/woow-k3s-pi-agent:<semver>`。本 image **以 digest 消費上游**，不重建 pi-web。

## 這顆 image 改了什麼（相對上游 0.3.2 native Omnigent UI）

| # | 改動 | 為什麼 |
|---|---|---|
| 1 | `/api/models-config` 回傳的 `providers.*.apiKey` 遮罩成 `__PI_REDACTED__:<末 4 碼>`；PUT 回寫時遇到遮罩值就還原磁碟上的原值 | 上游把 provider key 原樣回給瀏覽器（READINESS.md B3）。瀏覽器只是把它塞回 `<input>`，不需要真值 |
| 2 | 以 uid/gid **1000** 執行；`pi-web-start.sh` 的兩行 `/etc/localtime`、`/etc/timezone` 改為 best-effort | 上游是 root。腳本 `set -e`，非 root 寫 `/etc` 會直接讓容器起不來；Node 本身讀 `TZ` env，不靠 `/etc` |
| 3 | `VIDEO_PIPELINE_ENABLED=false`、`PI_WEB_HOSTNAME=127.0.0.1` 預設 | 影片工具鏈（720MB、Chromium）租戶版不提供；pi-web 只綁 loopback，由 chart 的 nginx sidecar 擋 Basic auth |
| 4 | omnigent CLI 0.16.0：`omnigent-requirements.lock`（`uv pip compile --generate-hashes`，94 個套件全釘版＋hash）以 `uv pip sync --require-hashes` 裝進 `/opt/omnigent/venv`，CPython 釘 3.12.14（uv 管理，uv 本身驗 release sha256、裝完不留）、建置時編好 bytecode（`UV_COMPILE_BYTECODE=1`）；`/usr/local/bin/omnigent`；`OMNIGENT_CONFIG_HOME`／`OMNIGENT_DATA_DIR` = `/data/pi-agent/home/.omnigent`；遙測關閉（`OMNIGENT_ANALYTICS=0`、`DO_NOT_TRACK=1`、`DISABLE_TELEMETRY=1`）；刪掉 Claude Agent SDK 自帶的 200 MB `claude`；`/etc/bash.bashrc` 載入 `omnigent-terminal.sh` | 讓 pi-agent 能當 Omnigent 的機器（host）：租戶在 pi-web 終端機 `omnigent login <omnigent 網址>`，chart 的 omnigent-host kit 在 **pi-web 容器裡**背景執行 supervisor（tini → launcher → pi-web-start.sh，沒有 sidecar），自動上線、重啟後自己回來。**launcher／supervisor／guard 都不在 image 裡**，由 chart 從 woow-paas-charts `shared/omnigent-host`（共用套件，ConfigMap）帶進來；image 只提供 omnigent CLI、tmux ≥ 3.3（基底 Debian 12 的 3.3a，基底以 digest 釘住）、flock／setsid。設定目錄就是原本手動安裝用的 `~/.omnigent`（HOME 在 volume 上），既有 host 的 host_id 與登入原樣沿用。終端機 hook：載入 kit 的 profile（kit bin 回到 PATH 最前面），`omnigent`／`omni` 一律走 kit 的 guard 再到 image 的 CLI（PVC 上手動裝的舊版蓋不過去；supervisor 在跑時第二個 `omnigent host` 會被明確拒絕），每個終端機在租戶需要動手時印一次狀態與登入指令。官方 Claude Code 與 Codex 已以獨立 npm lock 安裝，Omnigent 連接當下可用的引擎 |

| 5 | 文件工具：`python`（python-is-python3）、python3-docx、python3-openpyxl、python3-pypdf、python3-reportlab、poppler-utils、fonts-wqy-microhei（Debian 12 套件，版本釘死） | QA round 1 PA-02：pi 處理 Word／Excel／PDF 時沒有工具可用。中文 PDF：基底的 Noto CJK 是 CFF 字型，reportlab 不能嵌入（postscript outlines are not supported），所以另裝 TrueType 的文泉驛微米黑（`/usr/share/fonts/truetype/wqy/wqy-microhei.ttc`）。reportlab 內建的 CID 字型（例如 MSung-Light）不會嵌入，沒有中文字型的閱讀器和 pdftotext 都讀不出來，不要用。build 驗證用 `doc-tools-check.py` 實際產生並讀回 docx／xlsx（含公式）／pdf（含嵌入文泉驛字型的繁中 PDF：pypdf、pdftotext 讀回，pdffonts 顯示已嵌入） |

| 6 | 沒有模型或 provider 金鑰時按「傳送」：`/api/agent/new`、`/api/agent/[id]` 的錯誤文字改成「尚未設定模型：請點左下角「模型」，登入供應商（OAuth）或填入 API 金鑰……（No API key found for the selected model.）」；回應形狀不變（500、`code: prompt_rejected`、`accepted: false`，訊息照樣退回輸入框）。只改 pi 的三種訊息（No API key found／No model selected／No models available），其他錯誤原樣 | #1357：pi 原文是英文、叫租戶打 TUI 的 `/login`、還附兩個 `node_modules` 絕對路徑，pi-web 只用 5 秒 toast 顯示，租戶以為服務沒反應 |
| 7 | 上游首次啟動自動註冊的 Shared Runtime：Pi Web 安裝的 skills 與全域 MCP 會提供給 Claude Code、Codex；官方 CLI 已在映像內 | 新租戶不必另行下載 CLI 或手動安裝共享套件。Pi plugin／extension 是 Pi 專用程式碼，不跨代理載入；登入與帳號憑證仍由使用者完成 |

| 8 | 錯誤提示（`patch-error-hints.mjs`，AI-FIX-PI-3）：供應商回 401／403 → 對話內顯示「【金鑰無效或沒有權限】…請點左下角「模型」更正 API 金鑰…（原文：…）」；金鑰留空 → 「【這個模型目前不能使用】…」；磁碟寫滿（ENOSPC）→ 「【儲存空間已滿】…」；`/compact` 在對話太短時回 **HTTP 409**＋「【不需要壓縮】…」（原本 500＋英文），摘要被 token 上限截斷時指出要提高 maxTokens。改寫發生在 SSE 事件流（`/api/agent/<id>/events`）、`/api/sessions/<id>`、`/context` 與各 POST 路由的**回應層**，磁碟上的 session 檔仍保留供應商原文；提示後面一律附原文供客服 | AI-PI-001-1／002-2／005-3：租戶看到英文原始 JSON，不知道要去哪裡修；小對話按「壓縮」被當成伺服器錯誤 |
| 9 | 存檔後已開啟的對話立即採用新設定（#1461）：`PUT /api/models-config` 寫檔後，對每個存活 session 的 `modelRuntime.refresh({allowNetwork:false})`（pi-web 自己 `set_model` 用的同一個呼叫） | AI-PI-002-1：修正金鑰後，曾 401 的舊對話要閒置 ≥ 600 秒才恢復，而且每次重試都重置計時，越試越不會好。上游對應 issue／PR：agegr/pi-web #1273／#1287（0.12 以後的 `set_model` 重新整理；本 patch 讓 0.10 的存檔當下就生效） |
| 10 | 重啟中斷的工具呼叫補結果：session 檔被重新開啟（不在本程序記憶體）且最後一筆是沒有結果的 assistant 工具呼叫（`stopReason: toolUse`）時，追加一筆 `isError` 的 `toolResult`「【已中斷】服務在這個工具執行到一半時重新啟動…」。保護條件：檔案閒置 ≥ 60 秒（`PI_WEB_HEAL_MIN_IDLE_MS`）、只處理最後一筆；`PI_WEB_HEAL_INTERRUPTED_TOOLS=0` 關閉 | AI-PI-005-2：重啟後畫面沒有「已中斷」提示，模型也不知道原本的指令沒跑完 |
| 11 | uid 1000 的 passwd 家目錄＝`/data/pi-agent/home`（volume），不再是容器暫存層的 `/home/pi` | AI-PI-003-1：OpenSSH 的 `~` 看 `/etc/passwd` 不看 `$HOME`，預設 `ssh-keygen`／`known_hosts` 落在 `/home/pi/.ssh`，重啟（pod 換新）後整個消失，`git push` 失敗。build 以 `ssh -vvv` 驗證 `~/.ssh/known_hosts` 展開到 volume |
| 12 | Omnigent 原生 Pi session 的 branded LiteLLM 模型 ID 會依 canonical `/data/pi-agent/models.json` 補上能力與 context window | gateway 產生 `apporo-elmo/claude-sonnet-5-5` 等 alias 時原本沒有模型限制，Pi 便退回 128K；啟動器保留 session-local 目錄並同步唯一對應的 canonical metadata，讓 Sonnet 5.5 等模型取得 1M context window |

patch 用**精確錨點**（`patch-models-config.mjs`、`patch-prompt-errors.mjs`、`patch-error-hints.mjs`），錨點數 ≠ 1 就讓 build 失敗——pi-web 升版搬了程式碼時會被擋下，不會靜默漏 patch。

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

## 測試

- `tests/patch-error-hints.test.mjs`（`node --test`，Dockerfile build 內執行）：提示分類、冪等、原文保留與截斷、JSON replacer 只動錯誤訊息、每個 patch kind 的錨點缺少／重複都讓 build 失敗。
- `tests/e2e/run.mjs <pi-web 目錄> [--baseline]`：啟動**真的** pi-web（Next.js 編譯後的伺服器）＋假的 OpenAI 相容供應商（只收一把金鑰，其他回 LiteLLM 形狀的 401），逐項驗證：401 提示（SSE、重新載入、context 三處）、磁碟原文不變、存檔後同一個開著的對話立即用新金鑰（#1461）、小對話 compact 回 409、空金鑰提示、SIGKILL 殺掉整個程序群組後重開補「已中斷」結果、60 秒保護。`--baseline` 對**未打 patch** 的樹跑同一組場景，斷言原本的缺陷都會重現（證明場景有效）。PR gate：`.gitea/workflows/test-pi-agent-patches.yml`（`tests/patches.Dockerfile`，建在 Dockerfile 的 `BASE` 上）；候選 image 另在 `build-pi-agent-image.yml` 以 uid 1000 再跑一次。
- 本機：`npm install --prefix /tmp/pw @agegr/pi-web@0.10.0`，複製一份後依 Dockerfile 順序套 patch，再 `node tests/e2e/run.mjs /tmp/pw-patched/node_modules/@agegr/pi-web`。

## 0.3.2 native UI overlay 相容性

本次 PaaS `20261025.1200` 的 root 基準固定為 `v0.3.2`、source commit
`c9b31b4995cb246bdf2b4975c8d8a5095f3a02f9`。正式 base pin 為該版本的
官方 multiarch index digest
`sha256:927a947bb7ae4898ff72f46b1d3b88306b2ceba0c89965a74114c27aab2a27b6`；
amd64 / arm64 公開拉取與來源 revision 已核對，不追蹤 root `main`、`latest` 或另案 0.3.3。
既有完整 overlay 驗證使用 discovery-only 0.3.1 candidate；0.3.2 的 seed
腳本修正不改 Pi Web compiled files 或 bundled plugin。最終 digest 更新後
仍須通過 PR gate 與 phase1 成品檢查，才建立待真人核准的候選映像。
本次建置不改既有租戶 image pin，也不回退已上線的更新版本。

父映像包含 Pi Web 0.10.0、Next 16.4.3、Pi SDK 1.4.0 與
`pi-omnigent-plugin` 0.3.11。PaaS 以 `patch-pi-web.mjs` 一次預檢所有路由、
語法檢查完成後才寫入。Session chunk 依唯一 session-open 錨點定位，不再
依賴 webpack 的 `6429.js` 編號；缺少或出現多份匹配仍使 build 失敗。
原有隱私遮罩、錯誤提示、model runtime refresh、工具中斷修復與 OAuth
安裝 UUID 行為均保留。

Root 0.3.0 的 Pi launcher 已保留 `PI_CODING_AGENT_DIR`。PaaS 只追加
LiteLLM metadata enrichment；補丁同時接受舊 root 形狀、可重複套用，
不覆寫 session 的 provider key、模型 alias 或其他 gateway 的 metadata。
既有 Omnigent 0.16.0 Python lock、official CLI npm lock 不變。

驗證入口：

- `node --test pi-agent/tests/*.test.mjs`
- `python3 -B pi-agent/tests/patch-pi-context-window-launcher.test.py`
- `python3 -B pi-agent/tests/sync-litellm-model-metadata.test.py`
- `node pi-agent/tests/compiled-overlay-live.mjs <pi-web-dir>`：對實際 compiled tree
  驗證 chunk 改名、預檢失敗不留下半套補丁、重複套用。
- `node pi-agent/tests/e2e/run.mjs <pi-web-dir> [--baseline]`：真實 HTTP/SSE、
  GET/PUT 金鑰 round trip、同一 session 更新 key、compact、上傳、重啟復原。
- `node pi-agent/tests/e2e/native-ui.mjs <pi-web-dir> [plugin-dir]`：隔離 HOME，
  建立唯一 setup conversation、檢查 active plugin、全新安裝仍要求 server/account、
  拒絕缺少登入欄位與跨站操作、確認 `/omnigent` 頁面存在。沒有遠端登入或模型請求。

PR gate 與正式候選 image 使用相同補丁入口；成品測試以 uid 1000 再跑。
發布仍是 `pending-approval` 候選 image → 既有簽章 approval issue → 人類核准 →
registry promote；此變更不繞過、不代簽核准，也不更新 chart 或既有租戶。
