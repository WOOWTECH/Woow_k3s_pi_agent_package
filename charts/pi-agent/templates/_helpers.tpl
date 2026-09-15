{{- define "pi-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pi-agent.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s" (include "pi-agent.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "pi-agent.labels" -}}
app.kubernetes.io/name: {{ include "pi-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: pi-agent
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "pi-agent.selectorLabels" -}}
app: {{ include "pi-agent.fullname" . }}
{{- end -}}

{{- define "pi-agent.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "pi-agent.pvcName" -}}
{{- if .Values.persistence.existingClaim -}}
{{ .Values.persistence.existingClaim }}
{{- else -}}
{{ include "pi-agent.fullname" . }}-data
{{- end -}}
{{- end -}}

{{/*
Marks the `helm test` Pod. The Pod already carries app.kubernetes.io/instance
from pi-agent.labels, so this adds only the component half — repeating the
instance label here would emit a duplicate YAML key.
*/}}
{{- define "pi-agent.testLabels" -}}
pi-agent.woowtech.io/component: helm-test
{{- end -}}

{{/*
NetworkPolicy selector for that same Pod: both halves, so one release's test Pod
cannot reach another release's Service. Must stay in step with the labels above.
*/}}
{{- define "pi-agent.testSelectorLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
{{ include "pi-agent.testLabels" . }}
{{- end -}}
