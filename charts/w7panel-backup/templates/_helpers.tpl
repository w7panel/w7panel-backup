{{- define "w7panel-backup.minioName" -}}
{{- printf "%s-minio" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "w7panel-backup.s3Name" -}}
{{- printf "%s-s3" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
