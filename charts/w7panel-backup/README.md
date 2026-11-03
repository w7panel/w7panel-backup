# W7Panel Cluster Backup Chart

Installs Velero, a local PVC-backed S3 gateway, and the backup object index service.
The default storage location is `local` and can only be changed through Helm values.
The UI displays locations as read-only. Backups contain Kubernetes resource manifests,
not volume data or snapshots.

```sh
helm dependency build charts/w7panel-backup
helm upgrade --install w7panel-backup charts/w7panel-backup -n velero --create-namespace
```

The chart generates and retains local S3 credentials in `local-s3-auth` and
`local-s3-credentials`. Set `localS3.secretKey` before a first install if your
secret management process requires a supplied value. The gateway stores buckets
on the PVC selected by `localS3.storageClass` and `localS3.size`.

For external S3, set `localS3.enabled=false`, provide
`velero.configuration.backupStorageLocation` and
`velero.configuration.defaultBackupStorageLocation`, and set
`velero.credentials.existingSecret` to a separately managed Secret. The page
continues to show that location as read-only.

## Upgrade from bundled MinIO

The chart refuses an upgrade if it detects the old MinIO PVC but
`legacyMinio.enabled` is false. Keep the old MinIO service, PVC, credentials,
and `default` BackupStorageLocation to read historical backups:

```sh
helm upgrade w7panel-backup charts/w7panel-backup -n velero --reuse-values \
  --set legacyMinio.enabled=true
```

Copy the previous MinIO access key, secret key, bucket, storage class, and PVC
size into `legacyMinio` values before upgrading if they differ from the old
defaults. Do not delete the old PVC until historical backups are no longer needed.
If an upgrade fails, roll back the Helm release; no object data is migrated.

## Application selection

The UI reads W7Panel AppGroups and their `status.deployInfo.resourcesList`.
Backup, restore, and schedules accept multiple AppGroups. Shared resources are
shown once, and newly selected applications default their resources to selected.
For Deployments, StatefulSets, and DaemonSets, it also includes existing
ConfigMaps and Secrets directly referenced by their Pod templates. Users can
uncheck any resource; Secret contents are never shown in the selector.
It needs permission to list AppGroups in the visible namespaces, discover and
patch selected Kubernetes resources, and access
`services/w7panel-backup-index/proxy` in the Velero namespace. The index
service account has cluster-wide `get` and `patch` permissions to tag
AppGroup resources, and read permission for Velero backup downloads. Limit
access to the microapp and index Service Proxy through your existing W7Panel
RBAC. Application schedules reconcile new resource labels every 30 seconds;
failed sync pauses the schedule until it succeeds.

## Downloads and cross-cluster restore

The local S3 Service is only reachable inside the cluster, so direct browser
downloads remain unavailable. To enable downloads or share backups between
clusters, configure an HTTPS S3 endpoint reachable by browsers and all Velero
Pods in Helm. Target clusters should use a ReadOnly location for shared storage.
The chart's `backupSyncPeriod: 1m` discovers remote backups. Existing
same-name resources are retained during restore.
