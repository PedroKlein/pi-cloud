{{- define "pi-cloud.labels" -}}
app.kubernetes.io/name: pi-cloud
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "pi-cloud.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secret-key" .Release.Name) }}
{{- end }}

{{- define "pi-cloud.url" -}}
{{- if .Values.url }}{{ .Values.url }}
{{- else if .Values.apiRule.enabled }}https://{{ required "apiRule.host is required" .Values.apiRule.host }}
{{- end }}
{{- end }}
