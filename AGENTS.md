# Velero 备份排障记录

在 W7Panel 集群备份页面排障时，先查看 `Backup.status.validationErrors` 和 `BackupStorageLocation.status.message`；页面上的 `FailedValidation`、`Unavailable` 只是状态，不是具体原因。`FailedValidation` 的备份不会自动重试，修好存储位置后需用新名称创建备份。

- **内置 MinIO 无法解析**：确认存储位置的 `spec.config.s3Url` 与实际 MinIO Service 名称一致。Service 名称由 Helm release 决定；`charts/w7panel-backup/values.yaml` 默认写死 `http://w7panel-backup-minio:9000`，使用其他 release 名时可能不匹配。重装后也要等存储位置变为 `Available` 再创建备份。
- **浏览器下载**：内网 MinIO 地址只能供集群内使用。下载需要浏览器和 Velero Pod 均可访问的公网 HTTPS S3 API 地址；Ingress 的 HTTPS 入口转发到 MinIO Service 的 `9000` 端口，`9001` 是控制台。外网开放前更换 Chart 的默认 MinIO 密码。
- **COS 返回 `PathStyleDomainForbidden`**：COS 存储位置关闭 `s3ForcePathStyle`。Bucket 单独填写完整名称，上海地域的 S3 Endpoint 填 `https://cos.ap-shanghai.myqcloud.com`；不要把 Bucket 名写进 Endpoint，否则 SDK 再加一次 Bucket，会产生重复域名和 TLS 证书错误。
- **COS 提示 invalid top-level directories**：目标 Bucket 顶层有非 Velero 目录。使用专用空 Bucket，或在 `spec.objectStorage.prefix` 设置独立目录；当前页面没有 Prefix 字段，后续通过页面编辑该位置可能清除手工设置的 Prefix。
- **COS `ListObjectsV2` 返回 `403 AccessDenied`**：请求已到达 COS，应核对密钥所属账号、Bucket 名以及该 Bucket 的列表权限（`cos:GetBucket`）；备份还需要对象读写权限。不要通过输出 Secret 的 `.data` 字段排障，即使内容是 base64 编码也属于敏感凭据。
