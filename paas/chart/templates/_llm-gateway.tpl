{{/* Same-workspace LiteLLM wiring helpers (llmGateway.baseUrl → LITELLM_BASE_URL,
     networkPolicy.litellmEgress). Separate file so it never collides with _helpers.tpl edits. */}}
{{/*
Same-workspace LiteLLM gateway (llmGateway.baseUrl, injected by the platform:
http://<release>-litellm.<ns>.svc.cluster.local:4000/v1). CR/LF stripped, trimmed,
one trailing "/" removed; anything that is not a plain http(s) URL prints "" (no
env, no egress hole; NOTES says so) — never a render failure. A missing
llmGateway map (--reuse-values from an older chart) counts as "".
*/}}
{{- define "pi-agent.llmGatewayRawBaseUrl" -}}
{{- (.Values.llmGateway | default dict).baseUrl | default "" | toString | replace "\r" "" | replace "\n" "" | trim -}}
{{- end -}}
{{- define "pi-agent.llmGatewayBaseUrl" -}}
{{- $u := include "pi-agent.llmGatewayRawBaseUrl" . | trimSuffix "/" -}}
{{- if regexMatch "^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%\\[\\]-]+$" $u -}}{{ $u }}{{- end -}}
{{- end -}}
{{/* Runtime ConfigMap carrying LITELLM_BASE_URL (templates/llm-gateway-configmap.yaml). */}}
{{- define "pi-agent.llmGatewayConfigMapName" -}}
{{- printf "%s-llm-gateway" (include "pi-agent.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{/*
NetworkPolicy egress peer for the same-workspace LiteLLM proxy (charts/litellm labels
its proxy pod app.kubernetes.io/name=litellm + component=app; its database pod does
not match). Only while llmGateway.baseUrl is set; defaults apply when
networkPolicy.litellmEgress is missing (--reuse-values from an older chart).
Prints "" when no rule should be rendered.
*/}}
{{- define "pi-agent.litellmEgress" -}}
{{- $e := .Values.networkPolicy.litellmEgress | default dict -}}
{{- $on := ternary $e.enabled true (hasKey $e "enabled") -}}
{{- if and $on (include "pi-agent.llmGatewayBaseUrl" .) -}}
{{- $labels := $e.podLabels | default (dict "app.kubernetes.io/name" "litellm" "app.kubernetes.io/component" "app") -}}
{{- $ports := $e.ports | default (list 4000) -}}
{{- toYaml (dict "podLabels" $labels "ports" $ports) -}}
{{- end -}}
{{- end -}}
