{{- define "w7panel-backup.minioName" -}}
{{- printf "%s-minio" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
