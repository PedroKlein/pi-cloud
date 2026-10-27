{{- define "pipoca.labels" -}}
app.kubernetes.io/name: pipoca
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "pipoca.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secret-key" .Release.Name) }}
{{- end }}

{{- define "pipoca.url" -}}
{{- if .Values.url }}{{ .Values.url }}
{{- else if .Values.apiRule.enabled }}https://{{ required "apiRule.host is required" .Values.apiRule.host }}
{{- end }}
{{- end }}
