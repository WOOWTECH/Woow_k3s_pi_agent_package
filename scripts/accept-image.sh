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
for platform in "${platforms[@]}"; do
  timeout 300 docker pull --platform "$platform" "$image"
  id=$(docker create --platform "$platform" --label "pi.root.qa=$owner" --network none \
    --memory 3g --cpus 2 --entrypoint bash "$image" -ec \
    'node /opt/woow/tests/image-startup.mjs; node /opt/woow/tests/image-engine-discovery.mjs; node /opt/woow/tests/image-paseo.mjs')
  containers+=("$id")
  actual=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
  [[ $actual == "$revision" ]]
  timeout 240 docker start --attach "$id"
  [[ $(docker inspect -f '{{.State.ExitCode}}' "$id") == 0 ]]
done
# Internal bridge permits localhost browser access but denies external egress.
network=$(docker network create --internal --label "pi.root.qa=$owner" "$owner")
volume=$(docker volume create --label "pi.root.qa=$owner" "$owner")
timeout 300 docker pull --platform linux/amd64 "$image"
id=$(docker run -d --platform linux/amd64 --label "pi.root.qa=$owner" --network "$network" \
  --memory 3g --cpus 2 -p 127.0.0.1::30141 --mount "type=volume,source=$volume,target=/data/pi-agent" \
  -e VIDEO_PIPELINE_ENABLED=false "$image")
containers+=("$id")
plugin_version=$(docker exec "$id" node -p 'JSON.parse(require("fs").readFileSync("/opt/woow/pi-omnigent-plugin/package.json")).version')
expected_version=$(sed -n 's/^ARG PI_OMNIGENT_VERSION=//p' Dockerfile)
[[ $plugin_version == "$expected_version" ]]
base="http://$(docker port "$id" 30141/tcp)"
timeout 240 python3 tests/image-browser.py "$base" "$plugin_version" first image-browser-first.json
timeout 60 docker restart --time 15 "$id" >/dev/null
base="http://$(docker port "$id" 30141/tcp)"
timeout 240 python3 tests/image-browser.py "$base" "$plugin_version" restart image-browser-restart.json
python3 - "$receipt" <<'PY'
import json,sys
from pathlib import Path
c=json.load(open(sys.argv[1]));first=json.load(open('image-browser-first.json'));again=json.load(open('image-browser-restart.json'))
assert first['passed'] and again['passed'] and first['sessionHash']==again['sessionHash']
checks=['startup:'+p for p in c['platforms']]+['first-home-desktop','first-home-mobile','restart-persistence']
Path('image-acceptance.json').write_text(json.dumps({'candidate':c,'passed':True,'checks':checks,'browser':[first,again]},indent=2)+'\n')
print('PASS exact-image startup, desktop/mobile first home and persistent-volume restart')
PY
