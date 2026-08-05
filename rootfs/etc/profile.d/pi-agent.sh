# Make interactive shells (ttyd sessions, `kubectl exec -it ... bash -l`) see
# the same environment as the pi-web server process.
# shellcheck source=/dev/null
[ -r /usr/local/bin/pi-agent-env.sh ] && source /usr/local/bin/pi-agent-env.sh
