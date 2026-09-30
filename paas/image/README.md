# pi-agent image

供 PaaS 平台 cloud service 使用的 **pi coding agent（pi-web）** image。

- Registry：`jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent:{tag}`（tag = UTC `YYYYMMDD.HHMM`，走候選 tag → 核可 → promote）
- 平台側 **pin image digest**；chart 為 `woow-paas-charts` 的 `charts/pi-agent`。
- 上游：`WOOWTECH/Woow_k3s_pi_agent_package`（Gitea 鏡像 `woow-paas/Woow_k3s_pi_agent_package`），其 GitHub Actions 發佈 `ghcr.io/woowtech/woow-k3s-pi-agent:<semver>`。本 image **以 digest 消費上游**，不重建 pi-web。

## 這顆 image 改了什麼（相對上游 0.2.1）

| # | 改動 | 為什麼 |
|---|---|---|
| 1 | `/api/models-config` 回傳的 `providers.*.apiKey` 遮罩成 `__PI_REDACTED__:<末 4 碼>`；POST 回寫時遇到遮罩值就還原磁碟上的原值 | 上游把 provider key 原樣回給瀏覽器（READINESS.md B3）。瀏覽器只是把它塞回 `<input>`，不需要真值 |
| 2 | 以 uid/gid **1000** 執行；`pi-web-start.sh` 的兩行 `/etc/localtime`、`/etc/timezone` 改為 best-effort | 上游是 root。腳本 `set -e`，非 root 寫 `/etc` 會直接讓容器起不來；Node 本身讀 `TZ` env，不靠 `/etc` |
| 3 | `VIDEO_PIPELINE_ENABLED=false`、`PI_WEB_HOSTNAME=127.0.0.1` 預設 | 影片工具鏈（720MB、Chromium）租戶版不提供；pi-web 只綁 loopback，由 chart 的 nginx sidecar 擋 Basic auth |

patch 用**精確錨點**（`patch-models-config.mjs`），錨點數 ≠ 1 就讓 build 失敗——pi-web 升版搬了程式碼時會被擋下，不會靜默漏 patch。

## 升上游版本

改 `Dockerfile` 的 `ARG BASE=…@sha256:…`（index digest，`docker manifest inspect ghcr.io/woowtech/woow-k3s-pi-agent:<ver>` 取得），重跑 build；patch 錨點若不再吻合，到 `pi-web` 新版的 `.next/server/app/api/models-config/route.js` 重新對錨點。

## 本地驗證

```bash
docker build -f pi-agent/Dockerfile -t pi-agent:dev pi-agent
docker run --rm pi-agent:dev id                                   # uid=1000
docker run --rm -d --name p -e TZ=Asia/Taipei -v $(mktemp -d):/data/pi-agent pi-agent:dev
docker exec p sh -c 'printf "{\"providers\":{\"x\":{\"apiKey\":\"sk-secret-1234\"}}}" > /data/pi-agent/models.json'
docker exec p curl -s -H "Host: localhost" http://127.0.0.1:30141/api/models-config   # apiKey = __PI_REDACTED__:1234
```
