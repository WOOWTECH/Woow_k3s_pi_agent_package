# Managed Paseo 入口契約

Paseo 0.1.9 的 `/paseo-web` 使用 Pi Web 同一 origin。Chart 的既有 server-level
Basic Auth 與 `location /` 已能保護 shell、JS/CSS、build metadata、deep links 及
`/api/plugin-paseo`，不需要新增公開 port 或 `auth_basic off` 特例。

`bash charts/pi-agent/tests/test-managed-web.sh` 會渲染真實 chart，執行 nginx+njs，
用 loopback fixture 驗證 GET／HEAD 未登入為 401、登入後 URL 保持、Host shim、
private cache header，以及 10 次錯誤密碼後的 429 封鎖。另有刻意關掉 auth 的負向
對照，證明測試能抓到保護失效。四種 host/setup 開關組合都驗證唯一 :8080 入口、
Pi Web loopback 與繼承後的 uid/gid 1000。

需 Helm、Python/PyYAML、openssl、nginx+njs；缺少工具會失敗。可設定
`NGINX_BINARY`、`NGINX_MODULE_DIR`、`NGINX_MIME_TYPES` 使用本機解開的工具。
測試不呼叫 Kubernetes，也不讀真實帳號。只有 fixture 的路徑與 listen socket 被
替換；njs、防護 header、Basic Auth 與路由保留原始渲染內容。

此變更只有 tests，依 `docs/sop-charts.md` 不 bump Chart.yaml。本次新 root／PaaS
digest 尚未提供，故不更改 appVersion 或 image pin。舊 `20261026.1000` 候選 hold
不可 promote；新版本與 pin 由 parent 取得正式發布證據後統一處理。
