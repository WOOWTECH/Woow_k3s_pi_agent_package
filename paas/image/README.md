# pi-agent image

## Root 0.3.21：Paseo 0.1.14／Omnigent 0.3.29（2026-10-29）

PaaS 衍生映像的 root 基底改為
`ghcr.io/woowtech/woow-k3s-pi-agent:0.3.21@sha256:ce0895df04c00885a85638e59b44b3cc852ec92bff75d99ead0f0efdeb46bb34`（雙架構 index，
source revision `eba7b0925bc45799ff69916016480f48d9426401`）。內含 Paseo **0.1.14**、Omnigent **0.3.29**；
修正版 web 仍是 **0.13.0-woow.1**，`tests/managed-web-contract.json` 的 `paseoVersion` 已同步，Omnigent 外掛版本不變。
相對 root 0.3.20，使用者看得到的差異有兩項（都在 Paseo 外掛 0.1.14）：

1. **重啟不會再把 Paseo 關掉。** 以前 Paseo supervisor 只是被停止（容器重啟，或外掛來源改變後由新的 supervisor
   接手）就會把「停用」寫成持久狀態，要有人再啟用才會恢復；現在只有使用者在設定頁真的停用、或 Pi 停用該套件才會停用，
   被取代的舊 supervisor 不再動它。
2. **供應商模型清單為空或快取到錯誤時，登入後重整一次**，新登入不必重啟就看得到模型。

`host/adapter.patch` 與 Omnigent 組合補丁的雜湊與 0.3.20 相同，所以本層補丁與 e2e 不動。外掛來源路徑不變的租戶
（`/opt/woow/pi-paseo-plugin`）只換映像即可，Omnigent 登入與主機連線不受影響（2026-10-29 對 6 台租戶 1105→1328
實測登入保留，換 Paseo 版本是同一種只換映像的升級）。

## Root 0.3.20（歷史紀錄；現行基底見上節）：Paseo 0.1.13／Omnigent 0.3.29（2026-10-28）

PaaS 衍生映像的 root 基底改為
`ghcr.io/woowtech/woow-k3s-pi-agent:0.3.20@sha256:19a50724cc64b3337781003c56811edf1297618a98efa9ee171b358523acccc6`（雙架構 index，
source revision `54bf005c29bc42e201bc8c8f82ed7a834fdc4f40`）。內含 Paseo **0.1.13**、
Omnigent **0.3.29**；修正版 web 仍是 **0.13.0-woow.1**，`tests/managed-web-contract.json`
已同步。相對 root 0.3.17（Omnigent 0.3.26），使用者看得到的差異只有三項：

1. **Paseo 設定頁在零對話時可用。** 全新資料卷、還沒開過任何對話或專案時，
   `GET /api/plugin-paseo` 不再回 404（原本面板顯示「Paseo 不可用」）。未指定專案時，
   路由改用 `PI_PASEO_CWD`、否則 `$HOME` 當工作目錄（目錄必須存在）；
   明確要求某個專案路徑時，仍須是 Pi Web 已服務的根目錄。
2. **首頁 Get Started 多一行指引**（英／簡中／繁中）。繁中是「3. 開啟底部的「設定」，然後選擇
   「Omnigent」，把這台主機連到 Omnigent 伺服器」。綁定入口仍然只有 Settings → Omnigent：
   不建立設定對話、不自動開視窗（`tests/e2e/native-ui.mjs` 的「不建立」斷言原封不動）。
3. **手機版「設定 → Paseo」可以捲動**，內容左右留 16px 以上邊距，
   「產生配對連結」「儲存設定」兩顆按鈕都摸得到。

這版 root 內含的 Omnigent 外掛是 0.3.29（≥0.3.28，不建立設定對話），符合下一節的釘版條件。

上游證據（皆為 GitHub Actions）：

- main 候選（amd64）與 exact-image 驗收：[run 40682726949](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/actions/runs/40682726949)
- `v0.3.20` 標籤建置（amd64＋arm64）與 exact-image 驗收：[run 40684135613](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/actions/runs/40684135613)；
  驗收腳本新增「全新資料卷：Paseo 狀態在沒有專案時回 200」與「首頁第 3 步指引」兩項
- 受控發布（`0.3.20`／`0.3`／`0`／`main`／`latest` 同一 digest）：[run 40689585884](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/actions/runs/40689585884)
- 外掛 release：[pi-paseo-plugin v0.1.13](https://github.com/WOOWTECH/pi-paseo-plugin/releases/tag/v0.1.13)、
  [pi-omnigent-plugin v0.3.29](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.29)

**既有租戶升級須知。** Redeploy 只換映像，不會換 Pi 設定裡指向 git 舊 tag 的外掛
（例如 `git:…pi-omnigent-plugin@v0.3.23`）；要改指內建的 `/opt/woow/pi-omnigent-plugin`
才會用到新版。外掛來源一改，Omnigent 外掛會要求**重新登入一次**（Settings → Omnigent 輸入
帳號密碼；主機連線與引擎模型不受影響）。外掛來源本來就是內建路徑的租戶
（映像 1105 起新開通的）只換映像時**不需要重新登入**：2026-10-28 以 1105 啟動、登入後原地換成
root 0.3.20 候選映像實測，外掛 0.3.26→0.3.29，`loginConfirmed` 仍為 true、伺服器不變
（此測試的暫時 Pod 沒有 chart 的 host supervisor，主機連線的重連由 chart 負責，
PaaS 衍生候選映像上會再複驗）。

## Paseo 0.1.12 / Omnigent 0.3.26 PaaS 候選準備（2026-10-27，歷史紀錄；現行基底見上節）

成品契約已更新為 Paseo **0.1.12**、Omnigent **0.3.26** 與修正版 web
**0.13.0-woow.1**。完整 JSON response overlay（PR434）由 canonical main
保留；正式 BASE 固定在 root **0.3.17** 經雙架構驗收的 immutable digest。
這份來源契約不能代替 PaaS 候選映像驗收或人類批准。

Omnigent 與 Paseo 都只在 Pi Web 的 Settings 頁綁定：啟動、安裝與重啟不建立也不自動開啟
任何設定對話，首頁與右上角沒有額外入口（`tests/e2e/native-ui.mjs` 以映像 seed 兩次、
Pi Web 啟動、開 Settings 與重啟逐步斷言）。2026-10-27 的正式映像為 `20261027.1105`（Chart 0.1.15）。

**`20261027.1347`（root 0.3.18／Omnigent 0.3.27）已被 promote，但不得被任何 chart 或平台範本釘用，
也不得以它為基底再建。** 它在初次安裝時會自動建立一筆「Omnigent 連線設定」對話，與負責人
2026-10-27「只在設定頁綁定、不建立設定對話」的決定相反（root 0.3.18 的 seed 多了一行
`ensureOnboarding()`）。改用更新的 root 之前，其內含的 Omnigent 外掛必須是不建立設定對話的版本
（≤0.3.26 或 ≥0.3.28），且 `native-ui.mjs` 的斷言須維持「不建立」。

`20261026.1000`、`20261026.1100`、`20261026.1200` 均不得 promote。
1200 的 managed-web／launcher PASS 是歷史局部證據，不能清除其已知重啟缺陷；
核准 issue431 已關閉。新版本須使用未用過的候選 tag、同 source/digest 的完整
驗收與新封緘核准 issue；只有合法人類核可才可進入既有 phase2。

`tests/e2e/paseo-recovery.mjs` 在 uid1000、無網路且由 tini 收屍的獨立容器驗證映像內 r3：
先核對固定 lockfile、ready receipt、兩份官方 PID writer 與 transition helper
的發布 SHA256，再啟動真實 daemon。測試包括健康出生證明、受控舊 birth receipt
加上存活外來 sentinel 的復原、身分／登入／配對保留、未知舊 proof 拒絕、停用、
兩個獨立程序並行冷啟動只產生一個 supervisor。測試只改私有 QA record，
不複製或修補 runtime、不下載套件、不呼叫模型，不宣稱強制真實核心 PID 重用或 OOM。
PR layer、full_overlay 及 phase1 candidate push 前均執行；完整 overlay／候選映像
另確認 Claude Code、Codex、Pi 指令可執行。phase2 promotion 不變。

`tests/managed-web-contract.json` 固定插件版本、靜態發布包 SHA256、source 與
repair commit。`tests/e2e/managed-web.mjs` 以 uid 1000 執行 root 提供的
`/usr/local/bin/pi-paseo-web-seed.mjs`，讀取映像內
`/opt/woow/pi-paseo-web/client.tar.gz`，在獨立 HOME 種入快取，然後啟動套過
PaaS 補丁的真實 production Pi Web。驗證項目包含：

- production manifest 與實際 `/paseo-web` route 檔案，不能只有 source code。
- 未登入的 HTML、build metadata、JS/CSS 與 deep link 都導向登入；已登入的
  回應逐一比對發布包內容，避免把 Pi Web fallback HTML 誤認為 Paseo。
- uid 1000 的離線快取、HEAD、缺少資產、隱藏檔與 Host 防護。
- 移除插件後入口不再提供內容；重啟後不重新下載，登入與快取仍可用。

此測試不啟動 Paseo daemon、不讀操作者帳號、不配對遠端，也不送模型請求。
測試用本地覆寫可指定 `PASEO_WEB_SEED_MODULE` 與 `PASEO_WEB_ARCHIVE`；CI 成品
驗證不提供這些覆寫，因此必須真的包含 root 的離線檔案。PR test layer、完整
overlay smoke 與正式 candidate push 前都執行同一測試。Omnigent 原生 smoke
同樣從上述契約讀取版本，避免重編後仍以舊版常數放行。

`tests/image-launcher.py` 另在最終衍生映像以 uid 1000 執行未修改的
`/usr/local/bin/pi`：明確指定 Omnigent session 目錄與未指定兩種情境，驗證選定目錄、
含空白／空字串的 CLI 參數與 metadata hook 單次執行。PATH observer 只攔最終 CLI
以免送出模型請求；metadata hook 仍執行原始檔。輸出 command resolution、launcher／
CLI／hook SHA256，讓 parent 收入 candidate receipt。既有 launcher generator 與
legacy/current/idempotence 測試保持原樣；本機 fixture 通過不能代替最終映像證據。

這些檢查只提供技術證據；既有簽章 approval issue、人類核可與 promote 流程
未改動。完整 candidate image 成品測試、正式 registry 讀回與
chart／platform pin 仍由發布協調者依序完成。

供 PaaS 平台 cloud service 使用的 **pi coding agent（pi-web）** image。

- Registry：`jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent:{tag}`（tag = UTC `YYYYMMDD.HHMM`，走候選 tag → 核可 → promote）
- 平台側 **pin image digest**；chart 為 `woow-paas-charts` 的 `charts/pi-agent`。
- 上游：`WOOWTECH/Woow_k3s_pi_agent_package`（Gitea 鏡像 `woow-paas/Woow_k3s_pi_agent_package`），其 GitHub Actions 發佈 `ghcr.io/woowtech/woow-k3s-pi-agent:<semver>`。本 image **以 digest 消費上游**，不重建 pi-web。

## 這顆 image 改了什麼（相對上游 native Omnigent / Paseo UI）

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

## 0.3.17 Omnigent 更新的上游驗收

PaaS 衍生映像使用 root source revision `17e818aa83937be738e9ce7ba983a691e033a61e`，
以 `ghcr.io/woowtech/woow-k3s-pi-agent:0.3.17@sha256:8f4100559fa09fc4c7412bf8aabec1c70fe9d273ff9883b8b9e6f42fa89b64eb`
固定雙架構基底。root 內含 Omnigent **0.3.26**；原生 Pi 登入後模型目錄為空時，
插件會限次更新並重新查詢。
[上游候選與驗收](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/actions/runs/40487378788)
通過 amd64／arm64 啟動、首次桌面及手機首頁、重啟持久性；
[受控發布](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/actions/runs/40492103744)
把相同 digest 發布至 `0.3.17`、`0.3`、`0`、`main`、`latest`。
PaaS 衍生映像仍須完成自身的 overlay、候選成品與人工核可流程。

## 0.3.16 設定頁整合與成品驗收（歷史紀錄）

PaaS 的 root 基底使用 source revision `d2d9551daced90eea73d82cfa5f8c2fc1c34dbeb`，
精確釘在 `ghcr.io/woowtech/woow-k3s-pi-agent:0.3.16@sha256:2045fac5f8e4a97401464b4421658348a6197ce39df696fc648fdffec6023b3d`。
[tag CI](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/actions/runs/40458740240)
驗證 amd64／arm64 啟動，首次及重啟後的桌面與手機首頁均無 Paseo 捷徑或自動配對對話；
「設定 → Paseo」綁定入口可見，沒有模型請求或配對點擊。
root 內含 Paseo **0.1.12**、Omnigent **0.3.25**。
PaaS 衍生映像的非 root、CLI、managed Paseo Web、離線恢復已經以完整 overlay
[預檢](https://git-prod.woowtech.io/woow-paas/paas-odoo-ci/actions/runs/30262)；
新 JCR 候選仍需在同一正式 BASE 上重跑完整驗收，並取得該次專屬的人類核准。

## 0.3.15 native UI overlay 相容性（歷史紀錄）

前一版 PaaS image 的 root 基準固定為 `v0.3.15`、source revision
`ebf58077dfbc56559470f21936e3d21bd8e04a87`，以公開的雙架構 index
`ghcr.io/woowtech/woow-k3s-pi-agent:0.3.15@sha256:c6cc5812c760e1fa9253c3c8b4947df7fe58bd0ac26a19ec85b8988260d133dc`
消費。[tag CI](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/actions/runs/40428650001)
已通過 amd64／arm64 成品驗收；[受控發布](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/actions/runs/40434965883)
完成後，`0.3.15`、`0.3`、`0`、`main`、`latest` 的匿名讀回均指向同一 digest。

該版 root 包含 Paseo plugin 0.1.11、Omnigent plugin 0.3.22 與修正版離線 web bundle。
PaaS overlay 經 PR gate 與 `test-pi-agent-patches.yml` 的 `full_overlay=true`
驗證後，仍須通過新 candidate 的成品檢查與該次專用的人工核准，才可 promote。
本次來源更新不變更既有租戶 image pin，也不追蹤 root `main` 或 `latest`。

該版父映像包含 Pi Web 0.10.0、Next 16.4.3、Pi SDK 1.4.0 與
`pi-omnigent-plugin` 0.3.22。PaaS 以 `patch-pi-web.mjs` 一次預檢所有路由、
語法檢查完成後才寫入。Session 模組可能分別出現在 API 與 startup
instrumentation 的 chunk；overlay 依 session-open 錨點找出所有副本並逐一
套用，不依賴 webpack chunk 編號。找不到模組或單一檔案內錨點重複時，
仍使 build 失敗；所有輸出通過語法預檢後才寫入。
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
  驗證多份 session 模組、chunk 改名、預檢失敗不留下半套補丁、重複套用。
- `node pi-agent/tests/e2e/run.mjs <pi-web-dir> [--baseline]`：真實 HTTP/SSE、
  GET/PUT 金鑰 round trip、同一 session 更新 key、compact、上傳、重啟復原。
- `node pi-agent/tests/e2e/native-ui.mjs <pi-web-dir> [plugin-dir]`：隔離 HOME，
  執行映像 seed 兩次、啟動／重啟 Pi Web 與開 Settings，逐步斷言不建立 setup conversation
  或 onboarding 資料；檢查 active plugin、全新安裝仍要求 server/account、
  拒絕缺少登入欄位與跨站操作、確認 `/omnigent` 頁面存在。沒有遠端登入或模型請求。

PR gate 與正式候選 image 使用相同補丁入口；成品測試以 uid 1000 再跑。
發布仍是 `pending-approval` 候選 image → 既有簽章 approval issue → 人類核准 →
registry promote；此變更不繞過、不代簽核准，也不更新 chart 或既有租戶。
