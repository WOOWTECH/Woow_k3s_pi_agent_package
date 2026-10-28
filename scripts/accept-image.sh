#!/usr/bin/env bash
# Disposable CI containers only. No deployment, provider account, or host login.
set -Eeuo pipefail
receipt=${1:?candidate receipt required}
fields=$(python3 - "$receipt" <<'PY'
import json,re,sys
c=json.load(open(sys.argv[1]))
assert c['image']=='ghcr.io/woowtech/woow-k3s-pi-agent'
assert re.fullmatch(r'sha256:[0-9a-f]{64}',c['digest'])
assert re.fullmatch(r'[0-9a-f]{40}',c['revision'])
assert c['platforms'] in [['linux/amd64'],['linux/amd64','linux/arm64']]
print(c['image']+'@'+c['digest']);print(c['revision']);print(' '.join(c['platforms']))
PY
)
mapfile -t values <<< "$fields"
image=${values[0]}
revision=${values[1]}
read -ra platforms <<< "${values[2]}"
owner="pi-root-qa-$(python3 -c 'import uuid;print(uuid.uuid4().hex)')"
network='' volume='' containers=()
cleanup() {
  status=$?
  trap - EXIT
  set +e
  python3 scripts/image-qa-diagnostics.py "$owner" "$status" "${containers[@]}" || status=1
  for id in "${containers[@]}"; do
    if [[ $(docker inspect -f '{{index .Config.Labels "pi.root.qa"}}' "$id" 2>/dev/null) == "$owner" ]]; then
      docker rm -f "$id" >/dev/null || status=1
    else status=1; fi
  done
  if [[ -n $volume ]]; then
    if [[ $(docker volume inspect -f '{{index .Labels "pi.root.qa"}}' "$volume") == "$owner" ]]; then
      docker volume rm "$volume" >/dev/null || status=1
    else status=1; fi
  fi
  if [[ -n $network ]]; then
    if [[ $(docker network inspect -f '{{index .Labels "pi.root.qa"}}' "$network") == "$owner" ]]; then
      docker network rm "$network" >/dev/null || status=1
    else status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
# Pull each architecture by its child manifest. Docker cannot replace one local
# index-digest reference with a different platform's manifest on the same runner.
platform_ref_lines=$(python3 scripts/image_platform_ref.py "$image" "${platforms[@]}")
mapfile -t platform_images <<< "$platform_ref_lines"
[[ ${#platform_images[@]} == ${#platforms[@]} ]]
[[ ${platforms[0]} == linux/amd64 ]]
amd64_image=${platform_images[0]}
for index in "${!platforms[@]}"; do
  platform=${platforms[index]}
  platform_image=${platform_images[index]}
  timeout 300 docker pull --platform "$platform" "$platform_image"
  id=$(docker create --platform "$platform" --label "pi.root.qa=$owner" --network none \
    --memory 3g --cpus 2 --entrypoint bash "$platform_image" -ec \
    'node /opt/woow/tests/image-startup.mjs; node /opt/woow/tests/image-engine-discovery.mjs; node /opt/woow/tests/image-paseo.mjs')
  containers+=("$id")
  actual=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
  [[ $actual == "$revision" ]]
  timeout 240 docker start --attach "$id"
  [[ $(docker inspect -f '{{.State.ExitCode}}' "$id") == 0 ]]
done
# The runner can reach an internal bridge by container IP. Do not assume
# host-port publishing is available; keep external egress disabled.
network=$(docker network create --internal --label "pi.root.qa=$owner" "$owner")
# A tiny control server distinguishes Docker networking from application startup.
# Retain the old -p request here to record whether this Docker version honors it.
control=$(docker run -d --platform linux/amd64 --label "pi.root.qa=$owner" --network "$network" \
  --memory 128m --cpus 1 -p 127.0.0.1::30141 --entrypoint node "$amd64_image" -e \
  'require("http").createServer((q,s)=>s.end("pi-root-internal-network-ok")).listen(30141,"0.0.0.0")')
containers+=("$control")
control_base=$(python3 scripts/image-qa-network.py "$control" "$network" "$owner")
python3 - "$control_base" "$control" <<'PYCONTROL'
import json,subprocess,sys,time,urllib.request
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for attempt in range(20):
    try:
        with opener.open(sys.argv[1],timeout=1) as response:
            assert response.read()==b'pi-root-internal-network-ok'
        break
    except OSError:
        if attempt==19: raise
        time.sleep(.1)
c=json.loads(subprocess.check_output(['docker','container','inspect',sys.argv[2]],timeout=10))[0]
assert c['State']['Running']
from pathlib import Path
Path('image-network-control.json').write_text(json.dumps({'running':True,'directBridgeHttp':True,
    'requestedHostPort':True,'publishedPorts':c['NetworkSettings']['Ports'],
    'dockerServerVersion':subprocess.check_output(['docker','version','--format','{{.Server.Version}}'],timeout=10).decode().strip()},indent=2)+'\n')
PYCONTROL
volume=$(docker volume create --label "pi.root.qa=$owner" "$owner")
timeout 300 docker pull --platform linux/amd64 "$amd64_image"
id=$(docker run -d --platform linux/amd64 --label "pi.root.qa=$owner" --network "$network" \
  --memory 3g --cpus 2 --mount "type=volume,source=$volume,target=/data/pi-agent" \
  -e VIDEO_PIPELINE_ENABLED=false -e PI_WEB_HOSTNAME=0.0.0.0 "$amd64_image")
containers+=("$id")
plugin_version=$(docker exec "$id" node -p 'JSON.parse(require("fs").readFileSync("/opt/woow/pi-omnigent-plugin/package.json")).version')
expected_version=$(sed -n 's/^ARG PI_OMNIGENT_VERSION=//p' Dockerfile)
[[ $plugin_version == "$expected_version" ]]
base=$(python3 scripts/image-qa-network.py "$id" "$network" "$owner")
timeout 240 python3 tests/image-browser.py "$base" "$plugin_version" first image-browser-first.json
timeout 60 docker restart --time 15 "$id" >/dev/null
base=$(python3 scripts/image-qa-network.py "$id" "$network" "$owner")
timeout 240 python3 tests/image-browser.py "$base" "$plugin_version" restart image-browser-restart.json
python3 - "$receipt" <<'PY'
import json,sys
from pathlib import Path
c=json.load(open(sys.argv[1]));first=json.load(open('image-browser-first.json'));again=json.load(open('image-browser-restart.json'))
assert first['passed'] and again['passed']
assert len(first['views']) == len(again['views']) == 2
assert all(view['homeUnchanged'] and view['paseoShortcutAbsent'] and view['settingsBindingVisible']
           and view['setupConversationCount'] == 0 and view['modelRequests'] == 0
           and view['firstScreenOmnigentStep'] and view['paseoStatusWithoutProject'] == 200
           for phase in (first, again) for view in phase['views'])
checks=['startup:'+p for p in c['platforms']]+['first-home-desktop','first-home-mobile','restart-persistence']
Path('image-acceptance.json').write_text(json.dumps({'candidate':c,'passed':True,'checks':checks,'browser':[first,again]},indent=2)+'\n')
print('PASS exact-image startup, desktop/mobile first home and persistent-volume restart')
PY
