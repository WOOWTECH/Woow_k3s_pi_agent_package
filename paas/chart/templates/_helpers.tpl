{{/* pi-agent helpers. Deployed per-tenant by paas-operator as svc-{ref[:8]} into paas-ws-*. */}}
{{- define "pi-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "pi-agent.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- define "pi-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "pi-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pi-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "pi-agent.labels" -}}
helm.sh/chart: {{ include "pi-agent.chart" . }}
{{ include "pi-agent.selectorLabels" . }}
app.kubernetes.io/component: pi-agent
app.kubernetes.io/part-of: pi-agent
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}
{{- define "pi-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "pi-agent.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
{{/* Secret carrying admin_password — auth.existingSecret wins. */}}
{{- define "pi-agent.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-secret" (include "pi-agent.fullname" .) -}}
{{- end -}}
{{- end -}}
{{- define "pi-agent.pvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-data" (include "pi-agent.fullname" .) -}}
{{- end -}}
{{- end -}}
{{- define "pi-agent.authProxyConfigMapName" -}}
{{- printf "%s-authproxy" (include "pi-agent.fullname" .) -}}
{{- end -}}
{{/* explicit value wins; else the live Secret's value (stable across upgrades); else generate. */}}
{{- define "pi-agent.resolveSecretValue" -}}
{{- $ctx := .ctx -}}
{{- $val := .explicit -}}
{{- if not $val -}}
  {{- $live := lookup "v1" "Secret" $ctx.Release.Namespace (include "pi-agent.secretName" $ctx) -}}
  {{- if $live -}}
    {{- with $live.data -}}
      {{- with (index . $.key) -}}
        {{- $val = . | b64dec -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- if not $val -}}
  {{- $val = randAlphaNum 24 -}}
{{- end -}}
{{- $val -}}
{{- end -}}

{{/*
Tenant basic-auth username for the auth-proxy htpasswd. The platform lets
tenants change it (same mechanism as open-design), so it is validated here
rather than trusted: it is written verbatim into an htpasswd line
(`user:{PLAIN}pw`, nginx splits on the FIRST ':'). A ':' or whitespace would
silently split the credential into a different user/password pair; an empty
value would lock everyone out. Fail the render instead — helm keeps the old
release and the tenant keeps access.
*/}}
{{- define "pi-agent.basicAuthUsername" -}}
{{- $u := .Values.authProxy.basicAuthUsername | toString -}}
{{- if not (regexMatch "^[A-Za-z0-9._@-]{1,64}$" $u) -}}
{{- fail (printf "authProxy.basicAuthUsername %q is invalid: 1-64 characters from A-Z a-z 0-9 . _ @ -" $u) -}}
{{- end -}}
{{- $u -}}
{{- end -}}

{{/*
Exec probe command for the pi-web container (loopback, so httpGet cannot be used).
`curl -m` bounds the whole request, `--connect-timeout` the connect, and `timeout -s KILL` is the backstop that
kills curl itself if it ever ignores -m: the command ALWAYS exits within probe.seconds + 1, non-zero when pi-web
does not answer, so kubelet counts a failure instead of waiting on a hung exec (AI-PI-005-1).
*/}}
{{- define "pi-agent.probeCommand" -}}
{{- $max := int .Values.probe.curlMaxSeconds -}}
{{- if or (lt $max 1) (gt $max 8) -}}
{{- fail (printf "probe.curlMaxSeconds must be 1-8 (got %v): it has to stay below the liveness timeoutSeconds (10)" .Values.probe.curlMaxSeconds) -}}
{{- end -}}
{{- $url := printf "http://127.0.0.1:%v/api/home" .Values.piWeb.port -}}
{{- $cmd := printf "timeout -s KILL %d curl -sf -m %d --connect-timeout 2 %s >/dev/null" (add $max 3) $max $url -}}
["sh", "-c", {{ $cmd | quote }}]
{{- end -}}
