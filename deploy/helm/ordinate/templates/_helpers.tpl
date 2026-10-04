{{- define "ordinate.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ordinate.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ordinate.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ordinate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ordinate.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "ordinate.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ordinate.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ordinate.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "ordinate.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- /*
The container environment shared by the server and the migration Job: the
release's config (refusing secret names and the names the chart owns), then
every key of existingSecret (default: the Secret named like the release).
*/ -}}
{{- define "ordinate.env" -}}
{{- $secret := .Values.existingSecret | default (include "ordinate.fullname" .) -}}
{{- $secretNames := list "DATABASE_URL" "ORDINATE_MASTER_KEY" "OIDC_CLIENT_SECRET" "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY" "AWS_SESSION_TOKEN" -}}
{{- $owned := list "PORT" "METRICS_PORT" "DATA_DIR" "ORDINATE_ENV" -}}
{{- range $k, $v := .Values.config }}
{{- if has $k $secretNames }}{{ fail (printf "config.%s is a secret: put it in the existingSecret, never in values" $k) }}{{ end }}
{{- if has $k $owned }}{{ fail (printf "config.%s is set by the chart (service.port, metrics.port, data)" $k) }}{{ end }}
{{- end }}
env:
  - name: ORDINATE_ENV
    value: prod
  - name: PORT
    value: {{ .Values.service.port | quote }}
  - name: DATA_DIR
    value: /data
  {{- if .Values.metrics.enabled }}
  - name: METRICS_PORT
    value: {{ .Values.metrics.port | quote }}
  {{- end }}
  {{- range $k, $v := .Values.config }}
  {{- if ne (toString $v) "" }}
  - name: {{ $k }}
    value: {{ toString $v | quote }}
  {{- end }}
  {{- end }}
envFrom:
  - secretRef:
      name: {{ $secret }}
{{- end -}}

{{- define "ordinate.volumes" -}}
- name: data
  {{- if .Values.data.existingClaim }}
  persistentVolumeClaim:
    claimName: {{ .Values.data.existingClaim }}
  {{- else }}
  emptyDir:
    sizeLimit: {{ .Values.data.sizeLimit }}
  {{- end }}
# The root filesystem is read-only; Node and DuckDB write temp files here.
- name: tmp
  emptyDir:
    sizeLimit: 1Gi
{{- end -}}

{{- define "ordinate.volumeMounts" -}}
- name: data
  mountPath: /data
- name: tmp
  mountPath: /tmp
{{- end -}}
