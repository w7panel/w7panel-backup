# W7Panel Cluster Backup Chart

Installs Velero plus a MinIO S3-compatible store for a self-contained test setup.

```sh
helm dependency build charts/w7panel-backup
helm upgrade --install w7panel-backup charts/w7panel-backup -n velero --create-namespace
```

For production, disable `minio.enabled`, create `cloud-credentials` in the Velero namespace, and override the Velero BackupStorageLocation values with the external S3/COS endpoint and bucket. Do not commit production keys in values files.

## Browser downloads

Velero signs backup downloads using the configured `velero.configuration.backupStorageLocation[].config.s3Url`. To download from the W7Panel UI, configure this as a browser-accessible public HTTPS S3/COS endpoint (and ensure the Velero Pod can reach the same address). The bundled MinIO Service is cluster-internal and therefore suitable for backup testing only; its backup archives cannot be downloaded directly in a browser.

## Local UI development

`npm run dev` starts Vite and a loopback-only `kubectl proxy`. Open `http://127.0.0.1:8022`; the UI sends its Kubernetes calls to Vite's `/k8s-proxy` route, which uses the current `KUBECONFIG` (default: `~/.kube/config`). You can override `PORT`, `KUBE_PROXY_PORT`, or `KUBECONFIG` when starting the command.
