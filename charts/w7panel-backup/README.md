# W7Panel Cluster Backup Chart

Installs Velero plus a MinIO S3-compatible store for a self-contained test setup.

```sh
helm dependency build charts/w7panel-backup
helm upgrade --install w7panel-backup charts/w7panel-backup -n velero --create-namespace
```

For production, disable `minio.enabled`, create `cloud-credentials` in the Velero namespace, and override the Velero BackupStorageLocation values with the external S3/COS endpoint and bucket. Do not commit production keys in values files.
