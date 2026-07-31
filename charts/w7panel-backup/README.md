# W7Panel Cluster Backup Chart

Installs Velero plus a MinIO S3-compatible store for a self-contained test setup.

```sh
helm dependency build charts/w7panel-backup
helm upgrade --install w7panel-backup charts/w7panel-backup -n velero --create-namespace
```

For production, disable `minio.enabled`, create `cloud-credentials` in the Velero namespace, and override the Velero BackupStorageLocation values with the external S3/COS endpoint and bucket. Do not commit production keys in values files.

## Cross-cluster restore

Cross-cluster restore is performed by the Velero instance in the **target** cluster. Install this chart and the W7Panel Backup microapp in every participating cluster, then configure each cluster to use the same external S3/COS bucket, prefix, and endpoint.

1. In the source cluster, configure the BackupStorageLocation as `ReadWrite` and create the backup.
2. In the target cluster, configure the same BackupStorageLocation as `ReadOnly`. The chart's default `backupSyncPeriod: 1m` makes Velero discover backups in the shared storage.
3. Wait for the target cluster to show the synced backup in the W7Panel Backup page, then create a restore there. Resources are restored into the cluster currently connected to W7Panel.

Do not reuse backup names across source clusters that share a storage prefix. `ReadOnly` locations cannot create backups, but can synchronize and restore them. This chart currently backs up Kubernetes resource manifests only; PVC and volume data are not restored across clusters.

## Browser downloads

Velero signs backup downloads using the configured `velero.configuration.backupStorageLocation[].config.s3Url`. To download from the W7Panel UI, configure this as a browser-accessible public HTTPS S3/COS endpoint (and ensure the Velero Pod can reach the same address). The bundled MinIO Service is cluster-internal and therefore suitable for backup testing only; its backup archives cannot be downloaded directly in a browser.

## Local UI development

`npm run dev` starts Vite and a loopback-only `kubectl proxy`. Open `http://127.0.0.1:8022`; the UI sends its Kubernetes calls to Vite's `/k8s-proxy` route, which uses the current `KUBECONFIG` (default: `~/.kube/config`). You can override `PORT`, `KUBE_PROXY_PORT`, or `KUBECONFIG` when starting the command.
