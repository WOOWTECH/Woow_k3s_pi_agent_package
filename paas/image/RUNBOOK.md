# Pi Agent 租戶營運手冊

給營運與接手的人（包括 agent）看的單一手冊：PaaS 上的 Pi Agent 服務（chart `pi-agent`，映像由本 repo 的 [`pi-agent/`](README.md) 建置）連到 Omnigent 伺服器時的四件事。

1. [綁定](#1-綁定只在-settings--omnigent)
2. [主機被別的帳號佔用（HTTP 409、`reset-id`）](#2-主機被別的帳號佔用http-409reset-id)
3. [換外掛來源為什麼要重新登入，以及怎麼避免](#3-換外掛來源為什麼要重新登入以及怎麼避免)
4. [升級時保留登入的租戶升級流程](#4-升級時保留登入的租戶升級流程)

使用者看的說明在外掛 README（只留使用者版，並連到這裡）；腳本在 [`tools/pi-tenant/`](../tools/pi-tenant/README.md)，每支工具的參數與「會不會寫入」都寫在那裡。HA add-on 不在範圍（見 add-on 自己的 `DOCS.md`）。本檔在私有 repo，可以寫營運細節，但**不要寫入任何密碼、token 或 cookie**。

## 先記住四件事

- **綁定只在 Pi Web 的 Settings → Omnigent。不建立任何設定對話。**
- **每一批租戶開始前，先問負責人，得到明確同意。** 任何會讓租戶登出、重啟或改動租戶 volume 的步驟都一樣。不代簽核可、不代按 `/approve`。
- **Pi1（`svc-98687125`）永遠排除。** 它就是跑 agent 對話的那一台，升級它要另案、從 pod 外部操作。`tools/pi-tenant/` 的工具在程式裡就拒絕它。
- **遇到第一個失敗就停。** 不要為了讓檢查變綠而改檢查或補登入；回報現況、等負責人決定。

| 我看到 | 去哪裡 |
|---|---|
| host 在線，但設定頁顯示尚未登入 | 第 3 節（以及 1.5） |
| `needs-reset-id`、`NEEDS_RESET_ID`、HTTP 409 | 第 2 節 |
| 升級後 `verify_upgrade_one.py` 的 `loginPreserved` 沒過 | 第 4 節 → 第 3、2 節 |
| 升級後 Paseo 被關掉 | 第 4 節（`ensure_paseo.py`） |
| 租戶 volume 上還有幾 GB 的舊 Pi Web 副本、`realWeb` 指向它 | 第 4 節「舊租戶」 |

---

## 1. 綁定：只在 Settings → Omnigent

### 1.1 使用者怎麼綁

1. 開 Pi Web → 設定 → **Omnigent**。
2. 輸入 Omnigent Server URL、帳號、密碼。密碼欄遮罩，切換頁面會清空。平台不提供預設帳號。
3. 送出後外掛登入並連線這台主機（host）。

綁定完成不代表引擎能對話：每個已安裝的引擎（Claude Code、Codex、Pi）還需要各自可用的模型來源（各自登入供應商，或由 Omnigent 設定相容的 gateway），並通過設定頁的「驗證」。驗證會產生一次真實的模型回覆、用到額度，所以由使用者自己按，營運不代按。主機在線也不代表引擎能對話。

WOOW 目前的慣例（負責人決定）是所有 Pi host 以 Omnigent `admin` 帳號連線，host 屬於登入的那個帳號。審查（G9）建議改用專用的非 admin 帳號，並把 refresh grant 的上限從 365 天降到 90 天，尚待負責人決定；決定之前維持現狀。換帳號的後果見第 2 節。

### 1.2 為什麼只有這一條路：不建立設定對話

- 負責人 2026-10-27 決定：只在設定頁綁定，不建立設定對話。
- 外掛 0.3.27／root 0.3.18（映像 `20261027.1347`）曾在初次安裝時自動建立「Omnigent 連線設定」對話並連結，被否決，HA 0.15.14 因此撤回。外掛 0.3.28 起 `ensureOnboarding` 只是相容用的空殼。
- 所以：映像 `20261027.1347` 已被 promote，但**不得**被任何 chart 或平台範本釘用，也不得當基底再建。外掛 PR #14（替已移除的設定對話改檔案權限）不要合併，合併會把它復活。新的 root 或外掛版本，內含的外掛必須是不建立設定對話的版本（≤ 0.3.26 或 ≥ 0.3.28），`native-ui.mjs` 的「不建立」斷言也要維持。
- 啟動、安裝、重啟都不建立、也不自動開啟任何對話。首頁只有一行純文字提示指向 Settings → Omnigent，不是按鈕，不開對話。

### 1.3 看狀態（唯讀）

| 誰 | 怎麼看 |
|---|---|
| 租戶 | pi-web 終端機執行 `omnigent-host-status`（`--json` 印原始狀態，`--motd` 只在需要動手時才印）。結束碼：0 已連線或啟動中，1 需要動手，2 還沒有狀態檔。狀態檔是 `~/.omnigent/omnigent-host/status.json` |
| 營運（log） | `kubectl logs -n "$NS" "deploy/$REL-pi-agent" -c pi-web \| grep omnigent-host` |
| 營運（外掛視角） | `kubectl --context "$CTX" exec -i -n "$NS" "deploy/$REL-pi-agent" -c pi-web -- python3 -c "$(cat tools/pi-tenant/omni_login_verify.py)" view`：phase、`loginConfirmed`、server、host 是否連線、各引擎版本與驗證結果 |

注意：pod 的 readiness probe 只探測 pi-web，所以 **host 離線時 Pod 仍是 Ready**（審查 F3）。要判斷 host，看上面的狀態，不要看 Pod。

kit 的 `state` 中，租戶或營運需要處理的有這幾種：

| `state` | 意思 | 處理 |
|---|---|---|
| `waiting-login` | 還沒有 `auth_tokens.json`，host 在安靜地等 | 到 Settings → Omnigent 登入 |
| `login-expired` | 伺服器明確拒絕登入兩次（帳號被刪、refresh grant 被撤銷或過期） | 重新登入，帳號要和 host 原擁有者相同，否則見第 2 節 |
| `needs-reset-id` | host id 屬於別的帳號（HTTP 409） | 第 2 節 |
| `image-too-old` | 映像缺 tmux ≥ 3.3 或 omnigent CLI，或太舊 | 升級映像（第 4 節） |
| `duplicate-host` | 有人繞過 guard，手動啟動了第二個 host | 找出並停掉手動起的那一個 |
| `host-error`、`error` | host 反覆結束（指數退避重試）或其他錯誤 | 看 `omnigent-host-status` 與 log，再決定 |

`running` 只代表 host 的 log 出現過 `Connected as`，不保證伺服器端看到在線；伺服器暫時連不上時 detail 會寫「server unreachable right now」，host 不會因此停止。

### 1.4 操作員代為登入（要負責人同意，且帳密由負責人提供）

只有在租戶無法自己登入、而負責人同意時才做。**密碼只經 stdin**：不進 argv、環境變數、檔案、對話、PR 或收據；輸出已去敏。

```bash
# 帳密由負責人在自己的終端機輸入；一行 JSON 只經 stdin 進入容器
IFS= read -rsp 'Omnigent password: ' PW; echo
PW="$PW" python3 - "$SERVER_URL" "$USER_NAME" <<'PY' \
  | kubectl --context "$CTX" exec -i -n "$NS" "deploy/$REL-pi-agent" -c pi-web -- \
      python3 -c "$(cat tools/pi-tenant/omni_login_verify.py)" connect
import json, os, sys
print(json.dumps({"server": sys.argv[1], "username": sys.argv[2], "password": os.environ["PW"]}))
PY
unset PW
```

登入後再用 1.3 的 `view` 確認 `loginConfirmed: true`、host 連線。帳號必須是 host 原本的擁有者，否則會撞 409（第 2 節）。

### 1.5 常見誤解

- **終端機的 `omnigent login <url>` 不是綁定。** 它只寫 token，不會讓外掛認定已登入（`loginConfirmed` 不變）。chart 的 `NOTES.txt` 與 kit 的狀態訊息仍會教這條路（審查 G8 建議刪掉 `NOTES.txt` 的舊句，屬另案），租戶照做時，請引導回 Settings。
- **刪掉 `auth_tokens.json` 只是本機登出。** refresh grant 在伺服器上仍有效；要真的撤銷，得在 Omnigent 停用或刪除該使用者，kit 偵測到 401 後會停掉 host。
- **`kubectl exec` 開的 shell，`HOME` 可能和 Pi Web 不同。** 供應商登入要用同一個 HOME，否則登入成功但 Omnigent 讀不到：`env HOME=/data/pi-agent/home codex login --device-auth`、`env HOME=/data/pi-agent/home claude auth login --claudeai`。授權由使用者在瀏覽器完成。

---

## 2. 主機被別的帳號佔用（HTTP 409、`reset-id`）

### 2.1 症狀

任何一個：

- `omnigent-host-status` 顯示 `needs-reset-id`（結束碼 1）；kit 以指數退避重試。
- 設定頁登入後只顯示「操作尚未完成 (NEEDS_RESET_ID)」。**設定頁不會告訴使用者該做什麼**（審查 PC-08），要由營運說明。
- 伺服器回 HTTP 409，訊息叫人「請管理員移除」；但伺服器目前沒有任何路徑讓管理員做這件事（審查 G2）。

### 2.2 為什麼會發生

host id 存在租戶 volume 的 `~/.omnigent/config.yaml`，歸**第一次連上的那個 Omnigent 帳號**所有。換另一個帳號登入，伺服器就回 409。2026-10-28 就有一台租戶重新登入時用了不是原擁有者的帳號。

### 2.3 處理（照順序）

1. **先確認這次登入的帳號對不對。** 輸錯帳號是最常見的原因。host 該屬於原帳號就用原帳號重新登入（Settings → Omnigent）。host id 不變、對話歷史都在，**不需要** reset-id。
2. **確定真的要換帳號**（例如停用 `admin`、改用專用帳號）：先取得負責人同意，再在該租戶容器內執行
   ```bash
   kubectl --context "$CTX" exec -i -n "$NS" "deploy/$REL-pi-agent" -c pi-web -- omnigent host reset-id --yes
   ```
   映像已把 `OMNIGENT_CONFIG_HOME` 指到 `/data/pi-agent/home/.omnigent`，指令會讀到 volume 上那份 `config.yaml`。omnigent ≥ 0.16 支援 `--yes`（少了它會問 `[y/N]`）。reset-id 在 host daemon 執行時會拒絕，而 `needs-reset-id` 狀態下沒有 daemon，可以直接跑；kit 的 guard 對 `host reset-id` 放行。
   kit 偵測到 `config.yaml` 變動就立刻重試，host 會以**新的 host id** 自動連上，不必重啟 Pod。
3. **確認**：`omnigent-host-status` 回到 `running`；`omni_login_verify.py view` 顯示 `loginConfirmed: true`、host 連線。
4. **host id 變了，之前錄的基線就失效了。** 這台之後還要走第 4 節，就重新跑 `capture_ui_baseline.py`。

### 2.4 代價與善後

- 舊帳號底下會留下一筆離線的 host（每次 reset-id 都產生新的 uuid，舊列永遠留著）。跟舊 host 綁定過的對話歷史仍屬舊 host id。
- Omnigent 伺服器（v0.19.1 與上游 main）沒有刪除 host 的 API，`GET /hosts` 也只回 online／offline，看不出新舊（審查 G2）。清理只能由伺服器管理員做（目前是 exec 進 server 容器呼叫 `HostStore.delete_host`，屬正式服務操作，要負責人同意）。刪之前先確認該 host 離線、沒有綁定對話、不是別人在用的；刪除會把綁定對話的 host_id 設成 NULL。
- 所以**不要把 reset-id 當成「重試」按鈕**；QA 與測試也不要反覆 reset，每次都多一筆孤兒。
- 審查 G2 提出的伺服器端刪除 host API、`omnigent host remove`、設定頁的「重設 host id」屬於另案；在它們上線前，這一節的手動流程就是現行做法。

---

## 3. 換外掛來源為什麼要重新登入，以及怎麼避免

### 3.1 2026-10-28 發生了什麼

「外掛來源」是 Pi 的 `settings.json` `packages` 裡 Omnigent 外掛那一筆，例如 `git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21` 改成映像內建的 `/opt/woow/pi-omnigent-plugin`。

- 外掛用「自己的安裝路徑」判斷自己有沒有被註冊（外掛 0.3.29 `src/web.mjs:73-80`）。來源一換，還在跑的舊實例就找不到自己，狀態變成 `package-removed-or-unregistered`。
- `observeLifecycle`（`src/runtime.mjs:320-337`）把它當成停用：寫入 `loginConfirmed: false` 並清掉 `verification.json`。新路徑的實例啟用時看到 `nativeActive === false`，再重置一次。
- 這只重設外掛的同意旗標。host 其實一直在線（kit 的 token 與 host id 都沒動），但外掛拒絕 resume（`fresh-login-required`），使用者必須在設定頁重新輸入密碼。
- 輸錯帳號就走第 2 節：409、`reset-id`、新的 host id。

結果：10-28 的租戶升級，6 台裡有 4 台因為外掛來源從 git 釘選換成內建路徑而被迫重新登入，要用負責人的帳密；其中一台的 host 屬於另一個帳號，走了 409 與 `reset-id`，換了新的 host 身分。

**同一路徑的映像升級不會重設登入**（程式邏輯如此；真實前後對照目前只有 1 台有證據，其他 5 台當時的檢查是空洞通過，現在的 `verify_upgrade_one.py` 已改成拿不到證據就失敗）。

### 3.2 現在怎麼避免（外掛 ≤ 0.3.29、root ≤ 0.3.21 的時代）

1. **能不換來源就不換。** 只做映像升級（Redeploy），不動 `settings.json` 的 `packages`。外掛來源本來就是 `/opt/woow/...` 的租戶，同路徑換映像登入不受影響。
2. **非換不可時，一律當作會要求重新登入：**
   - 先問負責人；先準備好這台租戶 host 原擁有者的帳號與密碼（問負責人，不要猜）。
   - 先 `capture_ui_baseline.py`，留下換之前的 host id hash。
   - 換完通知使用者，用**原帳號**在 Settings → Omnigent 重新登入；負責人要求代為登入時才用 1.4。
   - 登入後再跑一次 `verify_upgrade_one.py`：`loginPreserved` 要回到 true（同一個 host id hash）。若變成新 host id，代表走了 `reset-id`，照 2.3 第 4 點重錄基線。
3. **Paseo 的釘選不要用 `switch_plugin_pins.py` 切換**，除非被換掉的那份 Paseo 已含 pi-paseo-plugin #13 的修正。已發佈的 Paseo（到 0.1.14 為止）都有這個問題：supervisor 的 poll loop 會在來源被換掉時把「停用」寫成持久狀態，Paseo 會一直關著。修正（PR #14）2026-10-29 已合併，還沒發版。工具預設就擋下含 Paseo 變更的計畫（`--skip-paseo` 只動 Omnigent；`--allow-paseo-switch` 要負責人同意，並準備用 `ensure_paseo.py` 恢復）。

### 3.3 外掛 0.3.30 與 root 啟動時搬遷釘選之後（預期，尚未發版）

審查（PC-03、F1）提出兩個互補的修正，預定隨下一輪 Pi 發版：

- **root 映像：啟動時改寫舊釘選並留收據。** seed 在 Pi Web 啟動**之前**把官方 repo 的 git／npm 釘選改成 `/opt/woow/pi-omnigent-plugin`（`extensions: []` 的停用項不動，ref 比內建版新的也不動，備份一次；順便把過期的 `realWeb` 改回 `/usr/local/bin/pi-web` 並重生 launcher；寫收據 `omnigent-plugin/image-migration.json`，Paseo 同理）。此時沒有任何舊外掛行程在觀察，依程式碼推論不會觸發重設。
- **外掛 0.3.30：以套件名稱而不是路徑判斷註冊**（`src/locate.mjs`）。同名套件仍註冊時，舊實例只標 `superseded` 並保持不動，不重設登入；只有同名套件完全消失或被明確停用才重設。

| | 現在（≤ 0.3.29、root ≤ 0.3.21） | 0.3.30 與搬遷都發版後（預期） |
|---|---|---|
| git 釘選 → 內建路徑 | 登出，要重新登入 | 映像啟動時自動搬，登入保留 |
| 同路徑換映像 | 登入保留 | 登入保留 |
| 停用再啟用外掛 | 要重新登入 | 要重新登入（刻意保留） |
| 已卡在「host 在線但 `loginConfirmed` 為 false」 | 只能重新登入 | 同左；審查建議的「採用現有登入」按鈕若上線，會驗證 `/v1/me`、host 擁有者與 kit 狀態，不收密碼 |

**這一小節是預期，不是已發佈的事實。** 用它之前先看發版說明，確認外掛與 root 的版本都含這兩項，並確認 `image-migration.json` 這類收據的實際名稱。在核對完之前，一律照 3.2 的規則。核對之後第一次真的搬遷，仍以 `verify_upgrade_one.py` 的 `loginPreserved` 為準：它是 false 就代表預期不成立，**停下來回報**，不要自己補登入。

---

## 4. 升級時保留登入的租戶升級流程

目標：把一批租戶升到新的 chart 與映像，租戶資料（PVC）不動、Omnigent 登入與 host 連線不斷、Paseo 配對不丟。這條路徑**不改租戶自己的檔案**（`settings.json`、`host.json`），所以外掛來源路徑不變、登入不會被重設。

### 4.1 關卡（缺一不可）

- **負責人逐批同意。** 每一批、每一個時段都先問，說明有哪些租戶、預期中斷多久。
- **Pi1 永遠排除。** `tools/pi-tenant/` 在程式裡拒絕它（wave 檔也無法把它列為租戶）。
- **目標已在正式站上線。** `run_redeploy_one.py` 會檢查產品範本已解析到目標 chart 與映像，否則以 `target_chart_not_rolled_out`／`target_image_not_rolled_out` 中止、什麼都不改。也就是帶新 seed 的平台版要先上線。
- **負責人的日常機器放最後，並在約定的安靜時段。** Pod 是 Recreate 策略，重啟會中斷執行中的對話約 2–3 分鐘；先通知使用者。
- **不要和平台或 Operator 的發版重疊**（10-28 的做法：租戶先升，Operator 後換）。
- **正式站的 exec 與 Odoo shell 在 agent 的自動模式會被擋**，需要負責人切到手動模式，或由負責人自己執行。
- **逐台、遇到第一個失敗就停。**

### 4.2 準備 wave 檔

wave 檔列出這一批的租戶與目標，放在 **repo 外**（內容是真實租戶清單；收據也預設寫在它旁邊）。欄位見 [`tools/pi-tenant/README.md`](../tools/pi-tenant/README.md#wave-檔)，範本是 `tools/pi-tenant/wave.example.json`。

1. 盤點目前有哪些 Pi Agent 服務（唯讀）：
   ```bash
   kubectl --context "$CTX" -n paas-system exec -i deploy/paas-odoo-platform -c odoo -- python - < tools/pi-tenant/readonly_inventory.py
   ```
2. 從範本複製出 wave 檔，填入 context、`baseline`（現況 chart 與 pi-web 映像 digest）、`target`（範本將釘的 chart、映像 tag 與 digest、映像內建的 Omnigent 與 Paseo 版本）、`tenants`（release、`odooId`、namespace）、PVC 名稱不是 `<release>-pi-agent-data` 的 `claims`、`excluded`。
3. `export PI_TENANT_WAVE=/路徑/wave-<批次>.json`（或每個指令加 `--wave`）。

### 4.3 每一台

```bash
python3 tools/pi-tenant/preflight.py > /dev/null && echo 盤點可讀   # 1. 先確認讀得到（內容很長，不必看）
python3 tools/pi-tenant/capture_ui_baseline.py "$REL"                  # 2. 基線（唯讀）
python3 tools/pi-tenant/run_redeploy_one.py "$REL"                     # 3. Redeploy（唯一寫入 Odoo 的步驟）
# 等 Odoo 顯示 running、Pod 2/2
python3 tools/pi-tenant/verify_upgrade_one.py "$REL"                   # 4. 驗證，必須印出 "passed": true
```

1. **基線**：記錄 launch chain、Paseo 金鑰 hash、Omnigent 登入與 host id 的 hash、Paseo 狀態。看不到 Omnigent 畫面，或已登入卻沒有 host id 時會拒絕建立基線，稍後重試，不要跳過。
2. **Redeploy**：工具檢查一遍閘門才呼叫平台的 `action_redeploy()`。印出 `CUTOVER_UNCERTAIN` 時**不要重跑**，先查 Helm 與 Odoo 實際狀態。
3. **等**：Odoo 帳本顯示 `running`、Pod `2/2`。
4. **驗證**：`verify_upgrade_one.py` 最多等約 150 秒讓 Paseo 與 Omnigent host 重連，然後印出 21 項檢查（附錄）。全過才結束碼 0。
5. **只有 `paseoHealthy` 沒過、且基線時 Paseo 是啟用的**，才修 Paseo（先 dry-run，再 `--apply`，然後回到第 4 步）：
   ```bash
   kubectl --context "$CTX" exec -i -n "$NS" "deploy/$REL-pi-agent" -c pi-web -- python3 - --was-enabled true < tools/pi-tenant/ensure_paseo.py
   kubectl --context "$CTX" exec -i -n "$NS" "deploy/$REL-pi-agent" -c pi-web -- python3 - --was-enabled true --apply < tools/pi-tenant/ensure_paseo.py
   ```
   `--apply` 會執行 `node /opt/woow/pi-paseo-plugin/bin/cli.mjs enable`，整批只要先取得負責人一次同意。基線就是關的 Paseo 絕不開。
6. **`loginPreserved` 沒過就停。** 重新登入要負責人的帳密與同意（1.4），帳號要用 host 原擁有者的，否則見第 2 節；原因與預防見第 3 節。
7. 下一台。
8. 可選：用 `omni_login_verify.py verify <engine>` 做一次真實的模型回覆驗證（花額度，負責人同意才做）。

**回復一台**：這條路徑沒有改租戶檔案，只要把版本退回去：`helm rollback` 到 `<收據目錄>/<release>-before.json` 裡記錄的 revision，再讓 Odoo 追上。

### 4.4 舊租戶：還有 git 釘選或 volume 上的舊 UI 副本

只有 `verify_upgrade_one.py` 顯示 `singleBundledOmnigentSource`／`paseoSourceIsBundledOrAbsent`／`launchChainIsNative`／`noStaleVolumeCopyRunning` 沒過時才需要。截至 2026-10-29 的盤點，現存的租戶釘選都已指向 `/opt/woow/...`、launch chain 原生、舊副本已刪，正常升級不會用到這一段。

舊版外掛曾把一份修過的 Pi Web（3–8.6 GB）建在租戶 volume 的 `~/.local/share/pi-omnigent-web/`，並把 `omnigent-plugin/host.json` 的 `realWeb` 指向它；Redeploy 不會改這些，所以升級後舊介面（設定對話、多出來的 Omnigent 入口）還在。步驟：

1. 先 Redeploy 並等 Pod 就緒，因為下面的工具會檢查內建外掛版本。
2. **換釘選**：先 `--dry-run`，確認計畫，再 `--apply`。
   ```bash
   kubectl --context "$CTX" exec -i -n "$NS" "deploy/$REL-pi-agent" -c pi-web -- python3 - --dry-run \
     --label "$WAVE" --expect-omnigent "$OMNI_VERSION" --skip-paseo < tools/pi-tenant/switch_plugin_pins.py
   ```
   **這會讓租戶登出（第 3 節）；Paseo 的釘選預設被擋（第 3.2 節第 3 點）**。`--skip-paseo` 之後 `verify_upgrade_one.py` 的 `paseoSourceIsBundledOrAbsent` 會繼續失敗，直到 Paseo 的釘選另外處理，這是預期的。
3. **重設 launch chain**（只有 `realWeb` 還指向 volume 副本或被捕捉的舊 launcher 的租戶；要先做完上一步）：`reset_launch_chain.py --dry-run --label "$WAVE"`，再 `--apply`。
4. `kubectl -n "$NS" rollout restart "deploy/$REL-pi-agent"`，等到就緒。啟動時 image seed 會依內建外掛重生 `pi-web` 與 `pi-omnigent-web` launcher。
5. `verify_upgrade_one.py`，必要時 `omni_login_verify.py view`。
6. **回收舊副本**（負責人同意後；每個步驟都有 `--dry-run`／`--apply`，遇到任何不預期的內容就拒絕）：`repoint_shared_runtime_host.py`（`shared-runtime/host.json` 的 `realWeb` 改回記錄的原始值；沒有這個檔的租戶會回報 `SHARED_RUNTIME_HOST_ABSENT`），然後 `remove_old_ui_copy.py`。
   Longhorn 的 `actualSize` 不會自己縮小，要在檔案系統做 TRIM 才會把空間還給主機磁碟。

**回復**：步驟 2、3 的備份是 `settings.json.pre-<label>.bak` 與 `omnigent-plugin/host.json.pre-<label>.bak`，還原後重啟即可。**舊副本刪掉之後，這些備份回不到舊介面（它們指向已刪的副本），不要還原。**

### 4.5 收尾

- 收據與 wave 檔留在 repo 外，不要提交（內含租戶資訊與 host id 的 hash）。
- 向負責人回報：每台的 `passed`、是否動用 `ensure_paseo.py`、有沒有人需要重新登入、host id 有沒有變。
- 下一批再問一次。

## 5. 部署本版後：清掉手動補的模型選單暫時措施

本版（`omnigent-model-options-patch`，README 補丁表第 13 列）之前，租戶自己在「模型」頁加的
OpenAI 相容閘道對 Omnigent 是隱形的 —— 「Configure Pi」只剩「Default」，Pi 在 Omnigent
裡完全不能用。2026-11-01 稽核時有兩台線上租戶是這個狀態，已先用**手動措施**救起來：

| namespace | release | 當時模型數 |
|---|---|---|
| `paas-ws-504a2b17` | `svc-08cf5049` | 53 |
| `paas-ws-504a2b17` | `svc-b1dd6303` | 63 |

措施內容（三項，全在 volume 上）：

- `auth.json` 多一個 provider 項目，值是**參照不是金鑰**：
  `!python3 /data/pi-agent/.omnigent-seed/read-provider-key.py <provider> /data/pi-agent/models.json`
- `models-store.json` 鏡射 `models.json` 的模型清單
- `/data/pi-agent/.omnigent-seed/read-provider-key.py`（解析 helper）

原檔備份在同目錄的 `*.pre-omnigent-seed`。

**這兩台滾到帶本補丁的映像之後，把三項都移除**（留著不會壞，但 `auth.json` 的優先序高於
`models.json`，多一層沒必要的間接）。移除腳本放在 `tools/pi-tenant/`（或臨時寫入 pod 的
`/tmp` 再執行）：讀 `auth.json`，刪掉 `key` 內含 `.omnigent-seed` 的 provider 項目，
把 `models-store.json` 寫回 `{}`，再 `rm -rf /data/pi-agent/.omnigent-seed`。

移除後驗一次，兩個數字要相等且大於 0（這時候靠的是映像裡的補丁）：

- `kubectl -n <ns> exec <pod> -c pi-web -- /opt/omnigent/venv/bin/python -c "from omnigent.harnesses.pi_native.credentials import pi_own_login_model_options as f; print(len(f()))"`
- `kubectl -n <ns> exec <pod> -c pi-web -- sh -lc 'pi --list-models | grep -c <provider>'`

**要退回**就把 `*.pre-omnigent-seed` 覆蓋回去。不必重啟 daemon：
`pi_own_login_model_options()` 每次呼叫都重讀這兩個檔，只有改程式碼才需要重啟。

> ⚠️ 不要把金鑰**複製**進 `auth.json`。它的優先序高於 `models.json`，租戶之後換金鑰時
> 舊值會蓋過新的，Pi 會壞掉而且很難查 —— 上面用參照就是為了避開這件事。
> 空項目（`{"<provider>": {}}`）也不行，會擋住憑證解析（`Provider is not configured`）。

## 附錄：`verify_upgrade_one.py` 的檢查

| 檢查 | 證明什麼 | 沒過時 |
|---|---|---|
| `odooRunning` | Odoo 帳本 `running`，沒有排隊、租約或錯誤訊息 | 等它跑完；有錯誤訊息就停下來看 Odoo |
| `chartTarget`、`revisionAdvanced` | Odoo 與 Helm 都在目標 chart，Helm revision 比升級前大且與 Odoo 一致 | Redeploy 沒成功或 Odoo 還沒追上；看 `-attempt.json` 與 Helm |
| `podReady`、`noRestarts` | deployment ready、容器 2/2、Running、沒有重啟 | 看 Pod 事件與 log |
| `imageTarget` | pi-web 實際跑的映像 digest ＝ 目標 | 範本釘的映像不對，停下來問 |
| `pvcPreserved`、`storageHealthy` | PVC 還是原本那顆（uid、PV、容量、storage class）、Bound、Longhorn healthy | **立刻停**，volume 是租戶資料 |
| `authBoundary` | `/` 未登入回 401，`/healthz-upstream` 回 200 | 認證 proxy 有問題 |
| `pluginLoaded`、`bundlesAtTarget` | 外掛 API 回 200、版本是預期、已安裝且啟用；內建外掛版本等於 wave 的預期 | wave 檔寫錯或映像不對 |
| `settingsOnlyBinding` | 沒有 `onboardingUrl`，舊 onboarding API 回 404 | 舊外掛還在跑，是第 1 節的回歸，**停** |
| `singleBundledOmnigentSource`、`paseoSourceIsBundledOrAbsent` | 外掛來源只剩 `/opt/woow/...` | 還有 git 釘選，見 4.4 |
| `launchChainIsNative`、`launchersPointAtBundle`、`noStaleVolumeCopyRunning`、`nativePiWebRunning` | 跑的是映像內建 Pi Web，沒有舊副本的程序 | 見 4.4 |
| `paseoIdentityPreserved` | Paseo 金鑰 hash 沒變（配對仍有效） | 停，先問再處理 |
| `paseoHealthy` | Paseo 在跑；或基線時就是關的 | 只有這項沒過且基線是啟用：`ensure_paseo.py` |
| `loginPreserved` | 升級前已登入，升級後仍登入、host 連線、host id hash 相同；兩邊任何一邊拿不到資料就失敗 | **停**，見第 3、2 節 |

## 參考

- 外掛 README（使用者版）：<https://github.com/WOOWTECH/pi-omnigent-plugin>
- Omnigent host kit（supervisor、guard、狀態檔、環境變數）：<https://git-prod.woowtech.io/woow-paas/woow-paas-charts/src/branch/main/shared/omnigent-host/README.md>
- 映像怎麼建、root 基底與驗證：[`pi-agent/README.md`](README.md)
- 模型選單補丁（為什麼需要、怎麼守門）：[`pi-agent/README.md`](README.md) 補丁表第 13 列
- 租戶工具：[`tools/pi-tenant/README.md`](../tools/pi-tenant/README.md)
- pi-paseo-plugin 的 [#10](https://github.com/WOOWTECH/pi-paseo-plugin/issues/10)（SIGTERM 會把 Paseo 關掉）與 [#13](https://github.com/WOOWTECH/pi-paseo-plugin/issues/13)（換來源時 poll loop 會把 Paseo 關掉）
